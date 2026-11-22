// V2.5-54 A12: the rail icons, their tooltips and the zone tab strip follow the UI language; English keywords stay searchable.
import { expect, test } from './fixtures';

test('rail_labels_follow_language_keywords_stay_english_searchable', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await app.goto('/'); // openWindow waits for the English "Connected" line
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  const right = app.locator('.ib.r');
  const left = app.locator('.ib.l');
  for (const [bar, name, tip] of [
    [left, '트리', '트리'],
    [left, '파일', '파일'],
    [left, '검색', '검색'],
    [right, '보드', '보드'],
    [right, '결정', '결정'],
    [right, '터미널', '터미널'],
    [right, '아티팩트', '아티팩트'],
  ] as const) {
    const icon = bar.getByRole('button', { name, exact: true });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute('data-tip', new RegExp(tip));
  }
  await expect(left.getByRole('button', { name: '설정', exact: true })).toBeVisible();
  await expect(right.getByRole('button', { name: '배치', exact: true })).toBeVisible();
  // The Board opens as a modal (v25f) labelled in Korean; Esc closes it before the palette.
  await right.getByRole('button', { name: '보드', exact: true }).click();
  await expect(app.getByRole('dialog', { name: '보드' })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog')).toHaveCount(0);
  // English keywords still find them: the palette ids, and the widget library's English titles.
  await app.keyboard.press('Meta+KeyK');
  await app.locator('.palette input').fill('board');
  await expect(app.locator('#palette-list [data-command="board.toggle"]')).toBeVisible();
});

// Ticket 991 C9 asked that no rail label be cut in any language. Ticket 1041 (owner 2026-11-22): the bars have no labels;
// every icon keeps its name in the window's language as its accessible name and its tooltip.
for (const language of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'])
  test(`rail_names_in_tooltip_${language}`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await app.addInitScript((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: l })), language);
    await app.goto('/');
    await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
    await expect(app.locator('.ib .ai').first()).toBeVisible();
    await expect(app.locator('.ib .ai .al')).toHaveCount(0);
    const unnamed = await app.locator('.ib .ai').evaluateAll((els) => els.filter((e) => !e.getAttribute('aria-label') || !e.getAttribute('data-tip')).map((e) => e.id));
    expect(unnamed).toEqual([]);
  });
