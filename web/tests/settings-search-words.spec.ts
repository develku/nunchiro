// Ticket 516 (scorecard F7, owner pick C): the Settings search finds a setting by what a user would type (a plain or near
// word, not its label), in Korean and English; choosing the hit opens its page with the row scrolled into view, focused and
// briefly highlighted. Cmd+F while Settings is open focuses the search box (a keymap command), not the terminal's find bar.
import type { Page } from '@playwright/test';
import { searchHas } from '../src/settings';
import { expect, openWindow, test } from './fixtures';

/** Opens the window (it waits for the English status line), then switches the language and reloads; then opens Settings. */
async function openSearch(app: Page, language: 'ko' | 'en' = 'en') {
  await openWindow(app);
  if (language !== 'en') {
    await app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), language);
    await app.reload();
  }
  const settings = app.locator(".settings[role='region']");
  await expect(async () => {
    if (!(await settings.isVisible())) await app.keyboard.press('Meta+Comma');
    await expect(settings).toBeVisible({ timeout: 1_000 });
  }).toPass();
  const box = app.getByRole('searchbox', { name: language === 'ko' ? '설정 검색' : 'Search settings' });
  await expect(box).toBeFocused();
  return box;
}

// A phrasing, the label of the row it must find (the results list shows `label · page`), and the field the jump focuses.
const CASES: { lang: 'ko' | 'en'; query: string; label: string; page: string; at: string }[] = [
  { lang: 'ko', query: '글씨 크게', label: '채팅 글자 크기', page: 'appearance', at: '[data-row="type.chatSize"] input' },
  { lang: 'ko', query: '다크 모드', label: '테마 모드', page: 'appearance', at: 'input[name="theme-mode"]' },
  { lang: 'ko', query: '자동 실행', label: '로그인 시 시작', page: 'general', at: '[data-setting="startAtLogin"]' },
  { lang: 'en', query: 'dark mode', label: 'Theme mode', page: 'appearance', at: 'input[name="theme-mode"]' },
  { lang: 'en', query: 'prevent sleep', label: 'Keep this Mac awake while a session is working', page: 'general', at: '[data-setting="keepAwake"]' },
  { lang: 'en', query: 'steer', label: 'Follow-up', page: 'keys', at: '[data-row="composer.followup"] input:checked' }, // lane 517's row
  { lang: 'en', query: 'beep', label: 'When a session ends', page: 'alerts', at: '[aria-label="Sound when a session is done"]' },
];

for (const c of CASES) {
  test(`settings_search_words ${c.lang} "${c.query}": finds ${c.label} and the jump lands on its row`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    const box = await openSearch(app, c.lang);
    await box.fill(c.query);
    const hit = app.locator('.smatches .smatch').filter({ hasText: new RegExp(`^${c.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ·`) });
    await expect(hit).toHaveCount(1);
    await hit.click();
    await expect(app.locator(`#snav-${c.page}`)).toHaveAttribute('aria-current', 'page');
    // The field takes the focus, its row is in view and carries the highlight, which goes after about 1.5 s.
    await expect.poll(() => app.evaluate((sel) => !!document.activeElement?.matches(sel), c.at)).toBe(true);
    const row = app.locator('.srow[data-found]');
    await expect(row).toHaveCount(1);
    expect(await row.evaluate((r) => r.contains(document.activeElement))).toBe(true);
    await expect(row).toBeInViewport();
    await expect(app.locator('.srow[data-found]')).toHaveCount(0, { timeout: 4000 });
  });
}

test('settings_search_words_reduced_motion: with reduced motion the found row has the outline and no fade', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.emulateMedia({ reducedMotion: 'reduce' });
  const box = await openSearch(app);
  await box.fill('prevent sleep');
  await app.locator('.smatches .smatch').first().click();
  const row = app.locator('.srow[data-found]');
  await expect(row).toHaveCount(1);
  expect(await row.evaluate((r) => [getComputedStyle(r).animationName, getComputedStyle(r).outlineStyle])).toEqual(['none', 'solid']);
});

test('settings_search_words_hangul_as_typed: a half-typed Hangul query still matches (the IME shows 큭 on the way to 크게)', () => {
  const words = '글씨 크게, 글씨 크기';
  for (const q of ['글씨 크게', '글씨 크', '글씨 큭', '글ㅆ', '글씨 크ㄱ']) expect(searchHas(q, words), q).toBe(true);
  for (const q of ['글씨 작', '글씨 큰']) expect(searchHas(q, words), q).toBe(false);
  expect(searchHas('DARK', 'Dark mode')).toBe(true);
});

for (const width of [900, 1440]) {
  test(`settings_search_words_chip_${width}: the ⌘F chip lies inside the nav while the box is empty; typing does not resize the box`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.setViewportSize({ width, height: 900 });
    const box = await openSearch(app);
    const chip = app.locator('.snavsearch .kbd');
    await expect(chip).toBeVisible();
    const nav = (await app.locator(".settings[role='region'] > nav").boundingBox())!;
    const c = (await chip.boundingBox())!;
    expect(c.x, 'chip left').toBeGreaterThanOrEqual(nav.x);
    expect(c.x + c.width, 'chip right').toBeLessThanOrEqual(nav.x + nav.width);
    expect(c.y).toBeGreaterThanOrEqual(nav.y);
    expect(c.y + c.height).toBeLessThanOrEqual(nav.y + nav.height);
    const before = (await box.boundingBox())!.width;
    await box.press('a');
    await expect(box).toHaveValue('a');
    await expect(chip).toBeHidden();
    expect((await box.boundingBox())!.width).toBe(before);
  });
}

// The ticket's before/after shot (SHOT=before on main): Settings in Korean, searching 글씨 크게.
test('settings_search_words_shot: 글씨 크게 in Korean', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  const box = await openSearch(app, 'ko');
  await box.fill('글씨 크게');
  await app.waitForTimeout(300);
  await app.screenshot({ path: `../.scratch/shots/516-${process.env.SHOT ?? 'after'}-${test.info().project.name}.png` });
  if (process.env.SHOT === 'before') return;
  // The jump: the row highlighted, the box empty again with its ⌘F chip.
  await app.locator('.smatches .smatch').filter({ hasText: /^채팅 글자 크기 ·/ }).click();
  await expect(app.locator('.srow[data-found]')).toHaveCount(1);
  await app.screenshot({ path: `../.scratch/shots/516-jump-${test.info().project.name}.png` });
});

test('settings_search_words_cmd_f: Cmd+F in Settings focuses the search box with its text selected; the terminal opens no find bar', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => {
    const w = window as unknown as { __finds: number };
    w.__finds = 0;
    window.addEventListener('nunchiro:terminal.find', () => w.__finds++);
  });
  const box = await openSearch(app);
  await app.locator('#snav-keys').click();
  await expect(box).not.toBeFocused();
  await app.keyboard.press('Meta+KeyF');
  await expect(box).toBeFocused();
  await box.fill('font');
  await app.locator('.smatches .smatch').first().focus();
  await app.keyboard.press('Meta+KeyF');
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
  expect(await app.evaluate(() => (window as unknown as { __finds: number }).__finds)).toBe(0);
  // The box shows the command's key.
  await expect(app.locator('.snavsearch .kbd')).toHaveText('⌘F');
  // Settings closed: Cmd+F is the terminal's find again.
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+Comma');
  await expect(app.locator(".settings[role='region']")).toHaveCount(0);
  await app.locator('.xterm').first().click();
  await app.keyboard.press('Meta+KeyF');
  await expect.poll(() => app.evaluate(() => (window as unknown as { __finds: number }).__finds)).toBe(1);
});

// Ticket 516 (looks check 2026-11-14): a real-app check could not type into the box. Key presses, as a person types them
// (the other cases use fill), reach the box and find the row, so the web build is not the cause.
test('settings_search_words_real_key_presses', async ({ app }) => {
  const box = await openSearch(app);
  await app.locator('#snav-keys').click();
  await app.keyboard.press('Meta+KeyF');
  await expect(box).toBeFocused();
  await app.keyboard.type('dark mode', { delay: 30 });
  await expect(box).toHaveValue('dark mode');
  await expect(app.locator('.smatches .smatch').first()).toContainText('Theme');
});

// Ticket 991 C14: the results sit right under the search field, and a result reads as its row's own title.
test('settings_search_results_under_field_C14: results under the box, named as the row', async ({ app }) => {
  const box = await openSearch(app);
  await box.fill('sound when a session is done');
  const results = app.getByRole('list', { name: 'Matching settings' });
  await expect(results.getByRole('button').first()).toHaveText('When a session ends · Notifications');
  const [boxBottom, listTop, groupsTop] = await Promise.all([
    box.evaluate((e) => e.getBoundingClientRect().bottom),
    results.evaluate((e) => e.getBoundingClientRect().top),
    app.locator('.settings nav .sgroups').evaluate((e) => e.getBoundingClientRect().top),
  ]);
  expect(listTop - boxBottom).toBeLessThan(40);
  expect(listTop).toBeLessThan(groupsTop);
});
