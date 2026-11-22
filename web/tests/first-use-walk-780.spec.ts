// Ticket 780 (first-use walk 9, F10): the dead ends a fresh walk found, one test each. The held-out palette queries were
// written before the walk (docs/tickets/v2/issues/780-firstuse-walk9-f10.md). The third (the working row's "3s" in the
// Korean window) is design-chat.spec.ts `working_row_in_korean`.
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';

/** The window in its language with one project and a running shell. */
async function open(app: Page, core: Core) {
  const s = core.shell(core.project('demo'), 'alpha');
  await app.goto('/'); // not openWindow: its Connected check is English
  await app.locator(`.tab[data-tab="${s.id}"]`).waitFor();
}

const QUERIES = { en: ['api key', 'API keys', 'openrouter'], ko: ['API 키', 'api 키'] } as const;
const SKILL = {
  en: { settings: 'Settings', page: 'Skills & hooks', name: 'Nunchiro skill', about: 'How to start, prompt, wait for and read other coding agents' },
  ko: { settings: '설정', page: '스킬·훅', name: 'Nunchiro 스킬', about: 'nunchiro CLI로 다른 코딩 에이전트를 시작하고' },
} as const;

for (const [lang, locale] of [['en', 'en-US'], ['ko', 'ko-KR']] as const) {
  test.describe(lang, () => {
    test.use({ locale });
    // D1: "api key" listed nothing, although Settings > Providers holds the API key services.
    test(`walk9_api_key_query_reaches_providers_${lang}`, async ({ app, core }) => {
      await open(app, core);
      await app.keyboard.press('Meta+KeyK');
      const input = app.getByRole('dialog').getByRole('combobox').first();
      for (const q of QUERIES[lang]) {
        await input.fill(q);
        await expect(app.locator('#palette-list [data-command]').first(), q).toHaveAttribute('data-command', 'providers.signin');
      }
    });

    // D2: the shipped skill's row showed its English name and description in the Korean window.
    test(`walk9_shipped_skill_row_in_window_language_${lang}`, async ({ app, core }) => {
      const w = SKILL[lang];
      await open(app, core);
      await app.getByRole('button', { name: w.settings, exact: true }).click();
      await app.locator('nav button[data-page]').filter({ hasText: w.page }).click();
      const row = app.locator('[data-row="ext:nunchiro"]');
      await expect(row).toContainText(w.name);
      await expect(row).toContainText(w.about);
      await expect(row.getByRole('switch', { name: w.name })).toBeChecked();
      if (lang === 'ko') await expect(row).not.toContainText(/How to|skill\b/);
    });
  });
}
