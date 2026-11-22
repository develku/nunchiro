// Ticket 626 (first-use walk 7, F10): the dead ends a fresh walk found, one test each. The held-out palette queries were
// written before the walk (docs/tickets/v2/issues/626-first-use-walk-7.md).
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';

/** For each query: the first 3 command ids the palette lists, typed through the input as a person does. */
const ask = (app: Page, queries: string[]) =>
  app.evaluate((qs) => {
    const input = document.querySelector<HTMLInputElement>('.palette input')!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    return qs.map((q) => {
      set.call(input, q);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return [...document.querySelectorAll('#palette-list [data-command]')].slice(0, 3).map((e) => e.getAttribute('data-command')!);
    });
  }, queries);

/** The window in its language with one project and a running shell; the palette open. */
async function open(app: Page, core: Core) {
  const project = core.project('demo');
  const s = core.shell(project, 'alpha');
  await app.goto('/'); // not openWindow: its Connected check is English
  await app.locator(`.tab[data-tab="${s.id}"]`).waitFor();
  return { project, s };
}

const THEME = ['settings.appearance.themeMode', 'settings.appearance.themes'];
const QUERIES = {
  en: [['change theme', THEME], ['switch theme', THEME], ['sign in', ['providers.signin']]],
  // "테마 바꾸기" listed only the font rows: their page is 화면과 테마 and their phrase 폰트 바꾸기.
  // Ticket 630: "테마 확인" matched every word only through that page name too (density, tab font, chat width, title bar).
  ko: [['테마 바꾸기', THEME], ['테마 변경', THEME], ['로그인', ['providers.signin']], ['테마 확인', THEME]],
} as const;

for (const [lang, locale] of [['en', 'en-US'], ['ko', 'ko-KR']] as const) {
  test.describe(lang, () => {
    test.use({ locale });
    test(`walk7_held_out_queries_reach_their_row_${lang}`, async ({ app, core }) => {
      await open(app, core);
      await app.keyboard.press('Meta+KeyK');
      await app.locator('#palette-list [data-command]').first().waitFor();
      const list = QUERIES[lang];
      const tops = await ask(app, list.map(([q]) => q));
      const misses = list.flatMap(([q, ids], i) => (ids.some((id) => tops[i].includes(id)) ? [] : [`"${q}" wants ${ids.join(' | ')} -> ${tops[i].join(', ')}`]));
      expect(misses).toEqual([]);
    });
  });
}

test('walk7_close_on_the_room_tab_says_it_stays', async ({ app, core }) => {
  await open(app, core);
  const room = app.locator('[data-room-tab]');
  await room.click();
  await app.locator('body').click({ position: { x: 700, y: 500 } });
  await app.keyboard.press('Meta+KeyW');
  const note = app.getByText('The Room tab stays open because it belongs to the project. To close another tab, switch to it first.');
  await expect(note).toBeVisible();
  await expect(room).toHaveAttribute('aria-selected', 'true');
});
