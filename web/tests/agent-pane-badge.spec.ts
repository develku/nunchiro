// needs 110 (side pane): the orange "Needs input" badge has its own room in the tab row. Finding S10 of the whole-app
// evaluator (74f3a340): at 1440x900 the badge overprinted the Preview tab's label.
import { expect, openWindow, test, type Core } from './fixtures';
import { injectPending, item } from './agent-pane';

const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created');

test('pane_badge_no_overlap: with a waiting session\'s pane open at the default width, the badge floats inside the pane and moves nothing', async ({ app, core }) => {
  const a = agent(core, 'a');
  const state = await injectPending(app);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  state.items[a.id] = [item(a.id, 'dialog', ['screen'])];
  state.push();
  const pane = app.locator('[data-side-pane]:not([hidden])');
  await expect(pane).toBeVisible();
  const badge = pane.locator('.need');
  await expect(badge).toContainText('Needs your answer');
  const bb = (await badge.boundingBox())!;
  // v25-shell-chrome (ticket 284 item 4): the pane has no tab strip, so the badge is an overlay on the pane's top right: it sits
  // inside the pane, over no row, and the terminal below does not move when it appears.
  await expect(pane.locator('.tdh')).toHaveCount(0);
  const box = (await pane.boundingBox())!;
  expect(bb.x).toBeGreaterThanOrEqual(box.x);
  expect(bb.x + bb.width).toBeLessThanOrEqual(box.x + box.width);
  expect(bb.y).toBeGreaterThanOrEqual(box.y);
  expect((await pane.locator('.pbody').boundingBox())!.y).toBe(box.y);
});
