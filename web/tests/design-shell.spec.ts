// V2.5-26 (ticket 147, needs 140): the window shell's motion language and the Settings scope picker.
import { expect, openWindow, test } from './fixtures';
import { shellFixture, working } from './design-shell.fixture';

const running = (app: import('@playwright/test').Page) =>
  app.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a as CSSAnimation).animationName ?? 'transition'));

test('motion_shows_working: each working session turns one arc on its tab, so the count reads at a glance', async ({ app, core }) => {
  const { a, b } = shellFixture(core);
  await openWindow(app);
  await working(core, a.id, b.id);
  await expect(app.locator('.tab .tdot[data-s="working"]')).toHaveCount(2);
  await expect.poll(async () => (await running(app)).filter((n) => n === 'arcspin').length).toBeGreaterThanOrEqual(2);
  // The session header's dot for the shown working session turns the same arc.
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator('.shead .st[data-s="working"]')).toHaveCSS('animation-name', 'arcspin');
});

test('motion_respects_reduced_motion: with reduced motion nothing in the window animates and the motion tokens are zero', async ({ app, core }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  const { a, b } = shellFixture(core);
  await openWindow(app);
  await working(core, a.id, b.id);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator('.tab .tdot[data-s="working"]')).toHaveCount(2);
  await expect(app.locator('.tab .tdot[data-s="working"]').first()).toHaveCSS('animation-name', 'none');
  await expect(app.locator('.shead .st[data-s="working"]')).toHaveCSS('animation-name', 'none');
  expect(await running(app)).toEqual([]);
  const tok = (n: string) => app.evaluate((x) => getComputedStyle(document.documentElement).getPropertyValue(x).trim(), n);
  expect([await tok('--motion-fast'), await tok('--motion-base')]).toEqual(['0s', '0s']);
});

