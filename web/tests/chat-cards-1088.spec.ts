// Ticket 1088 (owner 2026-11-23): a framed report in chat is one line by default and its chevron shows the frame, kept
// across a reload; the Artifacts widget marks the artifact the Preview shows until the Preview closes; the chat accent is
// the theme's own colour with no setting touched, and a picked swatch still wins.
import type { Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { chatAccent } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { LIGHT_PICK, type ThemePick } from '../src/themes/nunchiro';
import { installHost } from './fixtures/artifacts/cards/host';
import { gitChat, page1, written } from './fixtures/artifacts-widget/helpers';
import { append, chat, type ChatCore, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';
import { openTheme, token } from './theme-harness';

type Art = Awaited<ReturnType<typeof artifactServer>>;
const test = chatTest.extend<{ host: { opened: string[] } }, { art: Art }>({
  art: [
    async ({}, use) => {
      const art = await artifactServer({});
      await use(art);
      await art.close();
    },
    { scope: 'worker' },
  ],
  host: [
    async ({ page, art }, use) => {
      const opened: string[] = [];
      await installHost(page, art, opened);
      await use({ opened });
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    { auto: true },
  ],
});

const SHOTS = '../.scratch/shots/chat-cards-1088';
const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}-${name}-${test.info().project.name}.png` });

test('report_card_is_one_line_and_its_fold_survives_a_reload', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'line-1088', null);
  append(s.file, rec.user('write the report'), written(s, 'w1', 'report.html', page1('Report', '<h1>Big report</h1>')));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const line = view.locator('.acard.line[data-path="report.html"]');
  await expect(line).toHaveCount(1);
  await expect(view.locator('.acard.frame')).toHaveCount(0);
  await expect(line.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(line.locator('.ic')).toHaveText('html');
  await shot(page, 'line');
  await line.getByRole('button', { name: 'Show the preview' }).click();
  await expect(view.locator('.acard.frame[data-path="report.html"]')).toBeVisible();
  await page.reload();
  await expect(chat(page, s.id).locator('.acard.frame[data-path="report.html"]')).toBeVisible();
  await shot(page, 'frame-after-reload');
  await chat(page, s.id).getByRole('button', { name: 'Fold the preview' }).click();
  await expect(chat(page, s.id).locator('.acard.frame')).toHaveCount(0);
  await page.reload();
  await expect(chat(page, s.id).locator('.acard.line[data-path="report.html"]')).toHaveCount(1);
  await expect(chat(page, s.id).locator('.acard.frame')).toHaveCount(0);
});

const dock = (page: Page) => page.getByRole('complementary', { name: 'Artifacts' });
const rows = (page: Page) => dock(page).getByRole('list', { name: 'This session' }).getByRole('listitem');
const openWidget = async (page: Page) => {
  if (!(await dock(page).isVisible())) await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
};

test('artifacts_widget_marks_the_report_the_preview_shows', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'mark-1088', null);
  append(s.file, written(s, 'w1', 'a.html', page1('Alpha')), written(s, 'w2', 'b.html', page1('Beta')));
  await openChat(page, s.id);
  await openWidget(page);
  const row = (title: string) => rows(page).filter({ hasText: title }).locator('button.it');
  await expect(row('Alpha')).not.toHaveAttribute('aria-current');
  await chat(page, s.id).locator('.acard[data-path="b.html"]').getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('.preview .pv-frame')).toBeVisible();
  await openWidget(page);
  await expect(row('Beta')).toHaveAttribute('aria-current', 'true');
  await expect(row('Alpha')).not.toHaveAttribute('aria-current');
  await expect.poll(() => row('Beta').evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(await row('Alpha').evaluate((e) => getComputedStyle(e).backgroundColor));
  await shot(page, 'widget-marks-open');
  await page.locator('.preview .pv-top').getByRole('button', { name: 'Close Preview' }).click();
  await expect(page.locator('.preview')).toHaveCount(0);
  await openWidget(page);
  await expect(row('Beta')).not.toHaveAttribute('aria-current');
});

// A theme whose cursor is grey: its colour is the most saturated of palette 3-6 (here pink, slot 5).
const PINKISH: ThemePick = {
  id: 'imported:Pinkish',
  name: 'Pinkish',
  colors: parseGhostty('background = #282a36\nforeground = #f8f8f2\ncursor-color = #f8f8f2\npalette = 1=#ff5555\npalette = 2=#50fa7b\npalette = 3=#f1fa8c\npalette = 4=#bd93f9\npalette = 5=#ff79c6\npalette = 6=#8be9fd\n'),
};
const LATTE: ThemePick = { id: 'catalog:Catppuccin Latte', name: 'Catppuccin Latte', colors: parseGhostty(THEMES['Catppuccin Latte']) };
const MOCHA: ThemePick = { id: 'catalog:Catppuccin Mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) };
const settings = (page: Page, s: Record<string, unknown>) => page.addInitScript((v) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify(v)), s);
async function answer(page: Page, core: ChatCore) {
  const s = core.chat('accent');
  append(s.file, rec.user('go'), rec.assistant('### Fixed the test\n\nThe **object shape** is kept.'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.md h3')).toBeVisible();
  return view;
}
const hex = (rgb: string) => `#${(rgb.match(/\d+/g) ?? []).slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;

for (const theme of [LIGHT_PICK, LATTE, MOCHA, PINKISH])
  test(`chat_accent_follows_the_theme: ${theme.name}, default setting`, async ({ page, chatCore }) => {
    await settings(page, { themeMode: 'fixed', themeFixed: theme });
    const view = await answer(page, chatCore);
    const got = hex(await view.locator('.md h3').evaluate((e) => getComputedStyle(e).color));
    // The bundled theme paints tokens.css (its own blue, --run); any other theme derives its own colour.
    const want = theme === LIGHT_PICK ? (await token(page, '--run')).toLowerCase() : chatAccent(theme.colors, 0)['--chat-accent'];
    expect(got).toBe(want);
    expect(hex(await view.locator('.md p strong').evaluate((e) => getComputedStyle(e).color))).toBe(want);
    await shot(page, `accent-${theme.name.replace(/\W+/g, '-')}`);
  });

test('chat_accent_default_differs_by_theme_and_settings_show_theme_colour', async ({ page, chatCore }) => {
  const [latte, pink] = [chatAccent(LATTE.colors, 0)['--chat-accent'], chatAccent(PINKISH.colors, 0)['--chat-accent']];
  expect(new Set([latte, pink, '#0969da']).size).toBe(3);
  expect(pink).toBe('#ff79c6');
  await settings(page, { themeMode: 'fixed', themeFixed: LATTE });
  await answer(page, chatCore);
  await openTheme(page, false);
  const group = page.getByRole('radiogroup', { name: 'Chat accent' });
  await expect(group.getByRole('radio', { name: 'Theme colour' })).toBeChecked();
  await group.scrollIntoViewIfNeeded();
  await shot(page, 'settings-theme-colour');
});

test('chat_accent_picked_swatch_wins_and_an_old_default_moves', async ({ page, chatCore }) => {
  // A store from before this ticket with Magenta picked keeps it.
  await settings(page, { version: 3, themeMode: 'fixed', themeFixed: LATTE, chatAccent: 5 });
  const view = await answer(page, chatCore);
  const heading = async () => hex(await view.locator('.md h3').evaluate((e) => getComputedStyle(e).color));
  expect(await heading()).toBe(chatAccent(LATTE.colors, 5)['--chat-accent']);
  // A store from before this ticket at the old default (4) moves to Theme colour.
  await settings(page, { version: 3, themeMode: 'fixed', themeFixed: LATTE, chatAccent: 4 });
  await page.reload();
  await expect.poll(heading).toBe(chatAccent(LATTE.colors, 0)['--chat-accent']);
});
