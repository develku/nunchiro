// Ticket 70 (tree2, needs 107): a terminal refit redraws the agent's prompt and the core files it under a new item id;
// the Decisions widget replaces the card's buttons and focus fell to the page. The card gives the same button of the
// new item the focus back (focus only: nothing is sent, the risky allow still sends only on Enter). The re-file is
// driven here by the proxy (`px.patch` gives the item a new id), not by resizing under load.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { behind, fakes, gitRepo, PERMISSION, proxy, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';

async function setup(app: Page, core: Core, risky: boolean) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const a = core.agent(p, 'wt-a', 'go-a', true);
  const px = await proxy(app);
  // What the window itself sent (the proxy records only the answer, not the `confirmed` flag).
  await app.addInitScript(() => {
    const send = WebSocket.prototype.send;
    (window as unknown as { __answers: string[] }).__answers = [];
    WebSocket.prototype.send = function (m) {
      if (typeof m === 'string' && m.includes('"op":"answer"')) (window as unknown as { __answers: string[] }).__answers.push(m);
      return send.call(this, m);
    };
  });
  const frames = () => app.evaluate(() => (window as unknown as { __answers: string[] }).__answers);
  if (risky) px.risky.add('wt-a');
  await openWindow(app);
  await behind(app, a.id); // ticket 1030: these check the Decisions card
  show(a.cwd, 'go-a', PERMISSION(risky ? 'rm -rf build' : 'touch out-a'));
  await expect(app.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(app, 'right', 'Decisions').click();
  const side = sidebar(app, 'right');
  await expect(side).toHaveAttribute('data-widget', 'decisions');
  await expect(side.locator('.dc-item')).toHaveCount(1);
  return { px, side, frames };
}
/** Files the shown prompt under a new id, as the sidebar refit does, and returns the locator of the new item. */
async function refile(app: Page, px: Awaited<ReturnType<typeof proxy>>, n: number) {
  px.patch((d) => [{ ...d, id: `${d.id.replace(/-r\d+$/, '')}-r${n}` }]);
  const item = sidebar(app, 'right').locator(`.dc-item[data-item$="-r${n}"]`);
  await expect(item).toHaveCount(1);
  return item;
}

for (const act of ['deny', 'allow'] as const) {
  test(`refiled_prompt_keeps_focus_on_same_button (${act}): the new item's ${act} holds the focus; nothing is sent, no error`, async ({ app, core }) => {
    const { px, side } = await setup(app, core, false);
    await side.locator(`.dc-item [data-act="${act}"]`).focus();
    const item = await refile(app, px, 1);
    await expect(item.locator(`[data-act="${act}"]`)).toBeFocused();
    // A second re-file keeps following the button.
    await expect(await refile(app, px, 2).then((i) => i.locator(`[data-act="${act}"]`))).toBeFocused();
    expect(px.sent).toEqual([]);
    await expect(side.locator('.dc-hint.err')).toHaveCount(0);
  });
}

test('refiled_prompt_does_not_take_focus_from_elsewhere: a re-file after focus left the card moves nothing', async ({ app, core }) => {
  const { px, side } = await setup(app, core, false);
  const elsewhere = app.getByRole('button', { name: 'Open command palette' }); // ticket 1030: no session is in front, so no composer box
  await side.locator('.dc-item [data-act="deny"]').focus();
  await elsewhere.focus();
  await refile(app, px, 1);
  await expect(elsewhere).toBeFocused();
  await expect(sidebar(app, 'right').locator('.dc-item [data-act]:focus')).toHaveCount(0);
  // Focus on the page (nothing focused) after the user clicked away: also left alone.
  await elsewhere.blur();
  await app.mouse.click(5, 5);
  await refile(app, px, 2);
  expect(await app.evaluate(() => (document.activeElement as HTMLElement).dataset.act ?? null)).toBeNull();
  expect(px.sent).toEqual([]);
});

test('risky_allow_still_focus_enter_only: re-filed with the risky Allow focused it stays Allow and needs Enter; re-filed with Deny focused it lands on Deny', async ({ app, core }) => {
  const { px, side, frames } = await setup(app, core, true);
  const allow = (i = side.locator('.dc-item.risky')) => i.locator('[data-act="allow"]');
  await expect(side.locator('.dc-item.risky .warn')).toHaveText('Caution');
  // A click, Space and key 1 on the risky Allow send nothing (as before the change).
  await allow().click();
  await app.keyboard.press('Space');
  await app.keyboard.press('Digit1');
  expect(px.sent).toEqual([]);
  // Deny focused: the re-file lands on the new Deny, never on Allow.
  await side.locator('.dc-item.risky [data-act="deny"]').focus();
  const one = await refile(app, px, 1);
  await expect(one.locator('[data-act="deny"]')).toBeFocused();
  await expect(allow(one)).not.toBeFocused();
  // Allow focused: the re-file keeps it on the new Allow; still nothing sent, and key 1 or a click do not send.
  await allow(one).focus();
  const two = await refile(app, px, 2);
  await expect(allow(two)).toBeFocused();
  await app.keyboard.press('Digit1');
  await app.keyboard.press('Space');
  expect(px.sent).toEqual([]);
  // Only Enter on it sends, once, confirmed.
  px.hold = true;
  await app.keyboard.press('Enter');
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
  expect((await frames()).map((f) => JSON.parse(f).request).map((r) => [r.answer.type, r.confirmed])).toEqual([['allow_once', true]]);
});

test('risky_flip_never_restores_to_allow: a safe Allow focused, the re-filed item is risky: focus is not given to its risky Allow', async ({ app, core }) => {
  const { px, side } = await setup(app, core, false);
  await side.locator('.dc-item [data-act="allow"]').focus();
  px.risky.add('wt-a'); // the core now files the same prompt as risky
  const item = await refile(app, px, 1);
  await expect(item).toHaveClass(/risky/);
  await expect(side.locator('.dc-item [data-act]:focus')).toHaveCount(0);
  await app.keyboard.press('Enter');
  await app.keyboard.press('Space');
  await app.keyboard.press('Digit1');
  expect(px.sent).toEqual([]);
});
