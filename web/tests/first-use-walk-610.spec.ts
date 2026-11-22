// Ticket 610 (first-use walk 5, F10): the dead ends a fresh walk found, one test each. The held-out palette queries were
// written before the walk (docs/tickets/v2/issues/610-first-use-walk-5.md); the ones that found nothing now reach their row.
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { makeT, mergeAreas } from '../src/i18n';
import * as errors from '../src/i18n/areas/errors';
import * as gaps from '../src/i18n/areas/errors-gaps';
import { plainError } from '../src/errors';

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

/** The window in its language with one project and a running shell (a current session); no RC flag, as the web build. */
async function open(app: Page, core: Core) {
  const project = core.project('demo');
  const s = core.shell(project, 'alpha');
  await app.goto('/'); // not openWindow: its Connected check is English
  await app.locator(`.tab[data-tab="${s.id}"]`).waitFor();
  return { project, s };
}

const FONT = /^(font\.reset|settings\.\w+\.(termFontSize|chatSize|tabFont|codeSize|composerSize))$/;
const HELD_OUT: Record<'en' | 'ko', [string, RegExp][]> = {
  en: [
    ['change font size', FONT],
    ['sign in', /^providers\.signin$/],
    ['clear history', /^settings\.\w+\.history$/],
    ['check for updates', /^settings\.\w+\.buildInfo$/],
  ],
  ko: [
    ['로그인', /^providers\.signin$/],
    ['언어 바꾸기', /^settings\.general\.language$/],
    ['기록 지우기', /^settings\.\w+\.history$/],
    ['업데이트 확인', /^settings\.\w+\.buildInfo$/],
  ],
};

for (const [lang, locale] of [['en', 'en-US'], ['ko', 'ko-KR']] as const) {
  test.describe(lang, () => {
    test.use({ locale });
    test(`walk5_held_out_queries_that_found_nothing_reach_their_row_${lang}`, async ({ app, core }) => {
      await open(app, core);
      await app.keyboard.press('Meta+KeyK');
      await app.locator('#palette-list [data-command]').first().waitFor();
      const list = HELD_OUT[lang];
      const tops = await ask(app, list.map(([q]) => q));
      const misses = list.flatMap(([q, want], i) => (tops[i].some((id) => want.test(id)) ? [] : [`"${q}" wants ${want} -> ${tops[i].join(', ') || 'nothing'}`]));
      expect(misses).toEqual([]);
    });
  });
}

test('walk5_sign_in_opens_providers_where_an_agent_signs_in', async ({ app, core }) => {
  await open(app, core);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog').getByRole('combobox').fill('sign in');
  await expect(app.locator('#palette-list [data-command]').first()).toHaveAttribute('data-command', 'providers.signin');
  await app.keyboard.press('Enter');
  await expect(app.getByRole('heading', { name: 'Providers', exact: true, level: 1 })).toBeVisible();
});

test('walk5_queries_that_matched_keep_their_rows: the fallback runs only when nothing matched', async ({ app, core }) => {
  await open(app, core);
  await app.keyboard.press('Meta+KeyK');
  await app.locator('#palette-list [data-command]').first().waitFor();
  // "check" alone is all filler words: it keeps its own matches; "font size" matched before and is unchanged.
  const [check, font] = await ask(app, ['check', 'font size']);
  expect(check.length).toBeGreaterThan(0);
  expect(font[0]).toBe('font.reset');
});

test('walk5_room_tab_split_says_why_and_new_session_starts_in_the_project', async ({ app, core }) => {
  const { project } = await open(app, core);
  await app.locator('[data-room-tab]').click();
  await app.locator('body').click({ position: { x: 700, y: 500 } });
  await app.keyboard.press('Meta+KeyD');
  await expect(app.getByText('Splits open beside a session: open a session tab, then split.')).toBeVisible();
  // The new-session rows are not greyed on the Room tab: a terminal starts in the Room's project.
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog').getByRole('combobox').fill('New terminal');
  const row = app.locator('#palette-list [data-command="session.new.terminal"]');
  await expect(row).toHaveAttribute('aria-disabled', 'false');
  await row.click();
  await expect
    .poll(() => (core.cli('snapshot', '--json').sessions as { kind: string; project: string; state: string }[]).filter((s) => s.kind === 'shell' && s.project === project && s.state === 'running').length)
    .toBe(2);
});

test.describe('ko composer', () => {
  test.use({ locale: 'ko-KR' });
  test('walk5_closed_session_line_names_the_state_in_korean', async ({ app, core }) => {
    const p = core.project('demo');
    const s = core.shell(p, 's0', '/bin/sh', '-c', 'echo mark; exec cat');
    await expect.poll(() => core.read(s.id)).toContain('mark');
    core.cli('session', 'close', s.id);
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^연결됨$/ })).toBeVisible();
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog').getByRole('combobox').fill('s0');
    await app.locator(`#palette-list [data-command="session.open.${s.id}"]`).click();
    await expect(app.locator('.composer .why')).toHaveText('s0 닫힘: 읽기 전용');
  });

  test('walk5_stopped_session_line_names_the_state_in_korean', async ({ app, core }) => {
    // The walk's dead end: an agent the core restart leaves resumable read "상태: resumable".
    const p = core.project('demo');
    const s = core.agent(p, 'a0', `${p}/never`);
    core.run(['serve', 'stop', '--yes']);
    await core.restart();
    await app.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
    expect((core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.id)?.state).toBe('resumable');
    await app.goto('/');
    await expect(app.getByRole('status').filter({ hasText: /^연결됨$/ })).toBeVisible();
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog').getByRole('combobox').fill('a0');
    await app.locator(`#palette-list [data-command="session.open.${s.id}"]`).click();
    await expect(app.locator('.composer .why')).toHaveText('a0 재개 가능: 읽기 전용');
  });
});

test('walk5_deny_off_screen_says_answer_in_the_terminal', async () => {
  // The core's refusal when it cannot read the prompt it would answer (sessions.rs NOT_ON_SCREEN): the next action, in the
  // window's language, never the raw English line.
  const tables = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { errors, gaps } as never) as never;
  for (const lang of ['en', 'ko'] as const) {
    const t = makeT<string>(lang, lang, tables) as Parameters<typeof plainError>[0];
    expect(plainError(t, 'decision is no longer on screen')).toBe(t('err.g.answerTerminal' as never));
  }
});
