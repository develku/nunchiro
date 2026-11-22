// fix-qline (needs 130, fidelity bar rows 02/14): the only remaining live visual 못함 on the owner-check page.
// (1) at the default sidebar width the waiting row's sample question is not ellipsized, as ko/hiderows-r6.html shows it;
// (2) the elapsed time on the row goes through the catalogue, so 한국어 reads "2분" like the mockup.
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { riskPatches } from './fixtures/fid-tree';
import { openQuiet } from './tree-seed';
import { repo, show, worktree } from './visual/compare';

test.use({ viewport: { width: 1440, height: 900 } });
test.skip(({ browserName }) => browserName !== 'chromium', 'the tree’s width is measured in Chromium at the app’s width');

const QUESTION = 'npm test 실행 허용?';

/** The owner-check-1030 decision-simple scenario: a worktree row waiting on the mockup's own sample question. */
async function simple(app: Page, core: Core) {
  const p = repo(core, 'lumen');
  worktree(core, p, 'build-fix');
  openQuiet(core);
  await riskPatches(app, { 'build-fix': { waiting: 'permission', text: QUESTION } });
  await show(app, 'light');
}

const korean = async (app: Page) => {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  // V2.5-67: Language is a combobox on Settings' first page since 309459ab / 23ff2891 (15 -> 9 pages), no nav button or radio (language-page.spec.ts).
  await app.getByRole('combobox', { name: /Language/ }).selectOption({ label: '한국어' });
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  // Back to the tree: the session tab closes Settings, then the left bar's Tree icon (not translated yet, "Tree").
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator('.tab[data-tab]').first().click();
  const side = app.locator('.sbar[data-widget="tree"]');
  if (!(await side.isVisible())) await app.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(side).toBeVisible();
};

// scrollWidth does not reveal a cut on an `overflow: hidden` box, so the text's own range width is measured against the
// box it is clipped to. Before the fix the box was 92px for 104px of text (the row lost 14px to the project wrapper's
// dead rail gutter), which is the "npm test 실행 …" of the owner-check shot.
test('question_fits', async ({ app, core }) => {
  await simple(app, core);
  const [text, box, side] = await app.locator('.sess .q .qt').evaluate((e) => {
    const r = document.createRange();
    r.selectNodeContents(e);
    return [Math.round(r.getBoundingClientRect().width), (e as HTMLElement).clientWidth, Math.round(document.querySelector('.sbar.l')!.getBoundingClientRect().width)];
  });
  expect(text, `the question needs ${text}px in a ${box}px box at the ${side}px sidebar width`).toBeLessThanOrEqual(box + 1);
  // and the words are the mockup's whole question, not a prefix of it.
  await expect(app.locator('.sess .q .qt')).toHaveText(QUESTION);
});

test('time_localized', async ({ app, core }) => {
  await simple(app, core);
  // Ticket 1041: a your-turn row's age moved into its tip (the row shows "needs you"); it is still localized there.
  const tm = app.locator('.sess .row.wt2 .tip');
  // The patched item was observed 2 min ago (fixtures/fid-tree.ts); hiderows-r6 draws "2분".
  await expect(tm).toContainText('2 min');
  await korean(app);
  await expect(tm).toContainText('2분');
});
