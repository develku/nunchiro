// Ticket 1030 (docs/design/permcard-1121, approved 11-21): the session in front answers its ordinary permission request
// on a card right above its composer, and Decisions does not list it; a background session's stays in Decisions until
// it is opened; a risky one shows in both, and one answer clears both. A real core and fake agents (decision-rows-seed.ts).
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { fakes, gitRepo, pending, PERMISSION, proxy, show } from './decision-rows-seed';
import { icon, sidebar } from './d5b';

type Agent = { id: string; cwd: string };
async function setup(app: Page, core: Core) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const wt: Record<string, Agent> = Object.fromEntries(['a', 'b'].map((t) => [t, core.agent(p, `wt-${t}`, `go-${t}`, true)]));
  const px = await proxy(app);
  await openWindow(app);
  return { wt, px };
}
const line = (app: Page, a: Agent) => app.locator(`.q[data-line="${a.id}"]`);
const ask = async (app: Page, a: Agent, t: string, screen: string) => {
  show(a.cwd, `go-${t}`, screen);
  await expect(line(app, a)).toBeVisible({ timeout: 8000 });
};
const openTab = async (app: Page, a: Agent) => {
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect.poll(() => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab')).toBe(a.id);
};
const docked = (app: Page) => app.locator('.composer .deccard.docked');
/** The docked item is one the core holds and has held for 600 ms: a terminal refit (the sidebar opening) re-files the
 *  prompt under a new id, and an answer to the old id answers nothing (decisions-widget.spec.ts `settled`). */
const settled = (app: Page, core: Core) => {
  let last: string | null = null;
  let since = 0;
  return expect
    .poll(async () => {
      const shown = await docked(app).locator('.dc-item').first().getAttribute('data-item');
      const held = pending(core).some((d) => d.id === shown);
      if (!held || shown !== last) [last, since] = [held ? shown : null, Date.now()];
      return held && Date.now() - since >= 600;
    }, { intervals: [150] })
    .toBe(true);
};
const side = (app: Page) => sidebar(app, 'right');
const openDecisions = async (app: Page) => {
  await icon(app, 'right', 'Decisions').click();
  await expect(side(app)).toHaveAttribute('data-widget', 'decisions');
};
const inDecisions = (app: Page, a: Agent) => side(app).locator(`.deccard[data-session="${a.id}"]`);

test('front_session_card_above_composer: the card shows above the composer, Decisions has no item, the tree row keeps its mark', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await expect(docked(app)).toHaveAttribute('data-session', wt.a.id);
  // The mockup's line and labels: "Bash · touch out-a", Allow once (1), Deny (3); the deny field stays closed.
  await expect(docked(app).locator('.dc-what')).toHaveText(/^\s*Bash · touch out-a$/);
  await expect(docked(app).locator('.dc-item [data-act="allow"]')).toHaveText('Allow once1');
  await expect(docked(app).locator('.dc-item [data-act="deny"]')).toHaveText('Deny3');
  await expect(docked(app).locator('.dc-note')).toHaveCount(0);
  // Above the composer's box, not inside it.
  const [card, box] = await Promise.all([docked(app).boundingBox(), app.locator('.composer .cbox').boundingBox()]);
  expect(card!.y + card!.height).toBeLessThanOrEqual(box!.y + 1);
  await openDecisions(app);
  await expect(inDecisions(app, wt.a)).toHaveCount(0);
  await expect(side(app)).toContainText('Nothing waiting');
  await expect(line(app, wt.a)).toBeVisible();
});

test('background_session_moves_to_its_window: listed in Decisions while behind; opening it moves the card', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  await openTab(app, wt.a);
  await openDecisions(app);
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await expect(inDecisions(app, wt.b)).toHaveCount(1);
  await expect(docked(app)).toHaveCount(0);
  await openTab(app, wt.b);
  await expect(docked(app)).toHaveAttribute('data-session', wt.b.id);
  await expect(inDecisions(app, wt.b)).toHaveCount(0);
  await openTab(app, wt.a);
  await expect(inDecisions(app, wt.b)).toHaveCount(1);
});

test('risky_in_both_one_answer_clears_both: Caution card above the composer and in Decisions; one deny reaches the core once', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.risky.add('wt-a');
  await openTab(app, wt.a);
  await openDecisions(app);
  await ask(app, wt.a, 'a', PERMISSION('rm -rf build'));
  await expect(docked(app).locator('.dc-item.risky .warn')).toHaveText('Caution');
  await expect(inDecisions(app, wt.a).locator('.dc-item.risky')).toHaveCount(1);
  await expect(docked(app)).toContainText('Also in Decisions until answered.');
  await expect(inDecisions(app, wt.a)).toContainText('Also shown in its chat.');
  // A click on the risky allow never allows.
  await docked(app).locator('[data-act="allow"]').click();
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  // Hold the answer so the item stays: a second deny from Decisions must send nothing.
  px.hold = true;
  await docked(app).locator('[data-act="deny"]').click();
  await inDecisions(app, wt.a).locator('[data-act="deny"]').click();
  await app.waitForTimeout(400);
  // Look v34 S3-4: the docked Deny goes as deny_with (no words) so the core stops a hooked Claude's turn.
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([[wt.a.id, 'deny_with']]);
  px.hold = false;
});

test('risky_answer_clears_both: the confirmed allow (focus then Enter) on the card in front leaves neither place showing the item', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.risky.add('wt-a');
  await openTab(app, wt.a);
  await openDecisions(app);
  await ask(app, wt.a, 'a', PERMISSION('rm -rf build'));
  await expect(inDecisions(app, wt.a)).toHaveCount(1);
  await settled(app, core);
  await docked(app).locator('[data-act="allow"]').focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  await expect(docked(app)).toHaveCount(0, { timeout: 8000 });
  await expect(inDecisions(app, wt.a)).toHaveCount(0);
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([[wt.a.id, 'allow_once']]);
});

// Ticket 1097 changed the first half: a digit in the EMPTY composer answers the card (sidechat-card-1097.spec.ts); after text it is text.
test('keys_on_the_card: after text, 1 and 3 type into the composer; Shift+Tab reaches the card, then 1 allows once', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await expect(docked(app)).toBeVisible();
  const box = app.locator('#composer');
  await box.focus();
  await app.keyboard.type('x');
  await app.keyboard.press('Digit1');
  await app.keyboard.press('Digit3');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await expect(box).toHaveValue('x13');
  await expect(box).toHaveAttribute('placeholder', /Shift\+Tab/);
  await box.fill('');
  await settled(app, core);
  await app.keyboard.press('Shift+Tab');
  await expect(docked(app).locator('[data-act="allow"]')).toBeFocused();
  await app.keyboard.press('Digit1');
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  await expect(docked(app)).toHaveCount(0, { timeout: 8000 });
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([[wt.a.id, 'allow_once']]);
});

test('three_buttons_in_mockup_order: Allow once, Allow for this session (when the agent offers it), Deny', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.patch((d) => void (d.kind === 'permission' && (d.allow_always = 'Yes, and don\'t ask again this session')));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const buttons = docked(app).locator('.dc-btns > button');
  await expect(buttons).toHaveCount(3);
  const order = await buttons.evaluateAll((els) => els.sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
  expect(order).toEqual(['Allow once1', 'Allow for this session', 'Deny3']);
  await settled(app, core);
  await docked(app).locator('[data-act="allow-always"]').click();
  await expect.poll(() => px.sent.map((s) => s.answer.type)).toEqual(['allow_always']);
});

test('option_two_is_a_button: Claude\'s three-option prompt shows option 2 as "Allow for this session" (mouse only), not a text chip', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  // The core names Claude's option 2 as the session allow (its hook takes the rules for this session, ticket 1030).
  const two = 'Yes, and always allow access to work/ from this project';
  px.patch((d) => {
    if (d.kind !== 'permission') return;
    d.choices = [
      { label: 'Yes', keys: ['1', 'enter'], changes_settings: false },
      { label: two, keys: ['2', 'enter'], changes_settings: true },
      { label: 'No', keys: ['3', 'enter'], changes_settings: false },
    ];
    d.allow_always = two;
  });
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const always = docked(app).locator('[data-act="allow-always"]');
  await expect(always).toHaveText('Allow for this session');
  await expect(docked(app).locator('[data-act="option"]')).toHaveCount(0);
  await settled(app, core);
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/w87-1030-option-two.png') });
  // permcard-1121, as decision-rows dont_ask_again_only_in_card_by_mouse: mouse only. A 2 on the card, Tab, Enter
  // and Space send nothing; one click sends it.
  await expect(always).toHaveAttribute('tabindex', '-1');
  await docked(app).locator('[data-act="allow"]').focus();
  await app.keyboard.press('Digit2');
  await app.keyboard.press('Tab');
  await expect(always).not.toBeFocused();
  await always.focus();
  await app.keyboard.press('Digit2');
  await app.keyboard.press('Enter');
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await always.click();
  await expect.poll(() => px.sent.map((s) => s.answer.type)).toEqual(['allow_always']);
});

test('session_allow_names_its_scope: the button says what it adds, as the core checked it (the exact command)', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.patch((d) => void (d.kind === 'permission' && Object.assign(d, { allow_always: 'Yes, and don\'t ask again for touch commands', allow_scope: 'touch out-a' })));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const always = docked(app).locator('[data-act="allow-always"]');
  await expect(always).toHaveText('Allow for this session: touch out-a');
  await settled(app, core);
  await app.screenshot({ path: path.join(REPO, '.scratch/shots/w87-1030-scope.png') });
  await always.click();
  await expect.poll(() => px.sent.map((s) => s.answer.type)).toEqual(['allow_always']);
});

test('deny_answers_at_once: one Deny on the card above the composer answers (permcard-1121; look v34 S3-4), no field', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.patch((d) => void (d.kind === 'permission' && (d.deny_note = true)));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const deny = docked(app).locator('[data-act="deny"]');
  await expect(docked(app).locator('.dc-note')).toHaveCount(0);
  await expect(deny).toHaveText('Deny3');
  await settled(app, core);
  await deny.click();
  await expect.poll(() => px.sent.map((s) => [s.session, s.answer])).toEqual([[wt.a.id, { type: 'deny_with', text: '' }]]);
});

test('edit_card_shows_its_diff: a pending Edit shows the chat\'s diff lines and a project-relative path; 1 and 3 keep their keys (look v35 b S3-1)', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  const file = path.join(wt.a.cwd, 'src', 'a.txt');
  px.patch((d) => void (d.kind === 'permission' && (d.text = JSON.stringify({ file_path: file, old_string: 'one\ntwo', new_string: 'one\nthree' }))));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('edit a.txt'));
  await expect(docked(app).locator('.dc-what')).toHaveText(/^\s*Edit · src\/a\.txt$/);
  const diff = docked(app).locator('.dcard');
  await expect(diff.locator('.dh .path')).toHaveText('src/a.txt');
  await expect(diff.locator('.counts')).toHaveText('+1 −1');
  await expect(diff.locator('.dl > div')).toHaveText([' one', '-two', '+three']);
  // The docked card answers: no View or Accept/Reject on its diff.
  await expect(diff.locator('button.btn')).toHaveCount(0);
  await expect(docked(app).locator('.dc-item [data-act="allow"]')).toHaveText('Allow once1');
  await expect(docked(app).locator('.dc-item [data-act="deny"]')).toHaveText('Deny3');
  await settled(app, core);
  await app.screenshot({ path: path.join(REPO, `.scratch/shots/w108-s3-1-edit-card-${test.info().project.name}.png`) });
  await docked(app).locator('[data-act="allow"]').focus();
  await app.keyboard.press('Digit1');
  await expect.poll(() => px.sent.map((s) => s.answer.type)).toEqual(['allow_once']);
});

test('write_card_shows_its_lines: a pending Write shows the new file\'s lines', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.patch((d) => void (d.kind === 'permission' && (d.text = JSON.stringify({ file_path: path.join(wt.a.cwd, 'new.md'), content: 'hello\nworld\n' }))));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('write new.md'));
  await expect(docked(app).locator('.dc-what')).toHaveText(/^\s*Write · new\.md$/);
  await expect(docked(app).locator('.dcard .dl > div')).toHaveText(['+hello', '+world']);
});

test('edit_card_says_every_place: a replace_all Edit says it changes every place, above its lines (w108 review M1)', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  px.patch((d) => void (d.kind === 'permission' && (d.text = JSON.stringify({ file_path: path.join(wt.a.cwd, 'a.txt'), old_string: 'foo', new_string: 'bar', replace_all: true }))));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('edit a.txt'));
  await expect(docked(app).locator('.dc-every')).toHaveText('Every place it appears in the file:');
  await expect(docked(app).locator('.dcard .dl > div')).toHaveText(['-foo', '+bar']);
});

test('long_write_card_bounds: 200 lines at first in a 180 px scroller, Show all shows every line (w108 review S1)', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  const content = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
  px.patch((d) => void (d.kind === 'permission' && (d.text = JSON.stringify({ file_path: path.join(wt.a.cwd, 'big.txt'), content }))));
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('write big.txt'));
  const diff = docked(app).locator('.dcard');
  await expect(diff.locator('.dl > div')).toHaveCount(200);
  expect(Math.round((await diff.locator('.dl').boundingBox())!.height)).toBe(180);
  await diff.getByRole('button', { name: 'Show all 450 lines' }).click();
  await expect(diff.locator('.dl > div')).toHaveCount(450);
  expect(Math.round((await diff.locator('.dl').boundingBox())!.height)).toBe(180);
  await diff.getByRole('button', { name: 'Show first 200 lines' }).click();
  await expect(diff.locator('.dl > div')).toHaveCount(200);
});

test('look_shot_front_card', async ({ app, core }) => {
  test.skip(!process.env.LOOK_1030, 'look only');
  const { wt, px } = await setup(app, core);
  await openTab(app, wt.a);
  await ask(app, wt.a, 'a', PERMISSION('npm test'));
  await expect(docked(app)).toBeVisible();
  await app.waitForTimeout(500);
  await app.screenshot({ path: '../.scratch/look-1030/pw-A.png' });
  px.risky.add('wt-b');
  await openDecisions(app);
  await openTab(app, wt.b);
  await ask(app, wt.b, 'b', PERMISSION('rm -rf ~/build'));
  await expect(docked(app).locator('.dc-item.risky')).toBeVisible();
  await app.waitForTimeout(500);
  await app.screenshot({ path: '../.scratch/look-1030/pw-C.png' });
});
