// V2-8e (HIDEROWS, needs 95): decisions on the session rows that asked, icon actions and keys, the peek, the panel
// card with its breadcrumb, risky permissions, the deny instruction and "don't ask again". A real core and fake
// agents; the window's socket is proxied to count answers (decision-rows-seed.ts). Agent tokens are refused in core:
// crates/nunchiro-core/tests/decision_answers.rs `agent_tokens_cannot_answer_a_decision`.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxes, expect, openWindow, stripOnTop, test, unmoved, type Core } from './fixtures';
import * as decisions from '../src/i18n/areas/decisions';
import { fakes, gitRepo, noFront, PERMISSION, proxy, QUESTION, show } from './decision-rows-seed';
import { test as plain } from '@playwright/test';

type Agent = { id: string; cwd: string };
/** Worktree agents `wt-<t>` in project `repo`, plus `main-a` in the main folder; the proxy is on before the window opens. */
async function setup(app: Page, core: Core, names: string[] = ['a', 'b', 'c']) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const wt: Record<string, Agent> = Object.fromEntries(names.map((t) => [t, core.agent(p, `wt-${t}`, `go-${t}`, true)]));
  const main = core.agent(p, 'main-a', 'go-m') as Agent;
  const px = await proxy(app);
  await openWindow(app);
  return { p, wt, main, px };
}
const line = (app: Page, a: Agent) => app.locator(`.q[data-line="${a.id}"]`);
const block = (app: Page, a: Agent) => app.locator('.sess').filter({ has: line(app, a) });
const rowOf = (app: Page, a: Agent) => block(app, a).locator('.row.wt2');
const ask = async (app: Page, a: Agent, t: string, screen: string) => {
  show(a.cwd, `go-${t}`, screen);
  await expect(line(app, a)).toBeVisible({ timeout: 8000 });
};
/** The Decisions widget (right sidebar) lists every session's card: scope to one session. */
const dcard = (app: Page, a: Agent) => app.locator(`.deccard[data-session="${a.id}"]`);
const activeTab = (app: Page) => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab');
const openTab = async (app: Page, a: Agent) => {
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect.poll(() => activeTab(app)).toBe(a.id);
};

test('decision_attaches_to_session_row: on the asking session row, a main-folder one too; no separate decision rows', async ({ app, core }) => {
  const { wt, main } = await setup(app, core, ['a', 'b']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  show(main.cwd, 'go-m', PERMISSION('touch out-m'));
  await expect(line(app, main)).toBeVisible({ timeout: 8000 });
  // The worktree's decision is inside that worktree row's block, right under the row.
  await expect(rowOf(app, wt.a)).toHaveCount(1);
  await expect(rowOf(app, wt.a)).toHaveAttribute('data-menu-session', wt.a.id);
  const [r, q] = [await rowOf(app, wt.a).boundingBox(), await line(app, wt.a).boundingBox()];
  expect(Math.abs(q!.y - (r!.y + r!.height))).toBeLessThanOrEqual(2);
  // RC gap 3 (needs 92, needs 95): the main folder's waiting session has a row of its own, and its line sits right
  // under that row, below the header; only a project-level item (no session) sits under the header.
  const head = await app.locator('.grp[data-project="repo"] .row.head').boundingBox();
  const m = await line(app, main).boundingBox();
  expect(m!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);
  const mr = await rowOf(app, main).boundingBox();
  expect(Math.abs(m!.y - (mr!.y + mr!.height))).toBeLessThanOrEqual(2);
  // No separate decision rows (the V2-9 `.slot.item`), and the quiet worktree has no line.
  await expect(app.locator('.tree .slot.item')).toHaveCount(0);
  await expect(line(app, wt.b)).toHaveCount(0);
  await expect(app.locator('.tree .q')).toHaveCount(2);
});

test('icon_actions_and_number_keys_need_focus: click and keys 1, 3 answer once; keys elsewhere do nothing; tooltips say the keys', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  for (const t of ['a', 'b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  // Tooltips name the key; the line never prints one.
  const allowA = line(app, wt.a).locator('[data-act="allow"]');
  await expect(allowA).toHaveAttribute('aria-label', 'Allow (1)');
  await expect(line(app, wt.a).locator('[data-act="details"]')).toHaveAttribute('data-tip', 'Details (2)');
  await expect(line(app, wt.a).locator('[data-act="deny"]')).toHaveAttribute('data-tip', 'Deny (3)');
  expect(await line(app, wt.a).innerText()).not.toMatch(/\(\d\)/);
  // A double click on allow sends one answer.
  await allowA.dblclick();
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  // "1" typed in the composer is text, never an answer.
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Digit1');
  await app.waitForTimeout(300);
  expect(px.sent.filter((s) => s.session === wt.b.id)).toHaveLength(0);
  // With row b focused, 1 allows once, however often it is pressed.
  await rowOf(app, wt.b).focus();
  await app.keyboard.press('Digit1');
  await app.keyboard.press('Digit1');
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  // 3 opens the deny instruction; Enter with nothing typed is a plain deny.
  await rowOf(app, wt.c).focus();
  await app.keyboard.press('Digit3');
  await expect(block(app, wt.c).locator('.dn input')).toBeFocused();
  await app.keyboard.press('Enter');
  await expect.poll(() => px.sent.filter((s) => s.session === wt.c.id).map((s) => s.answer)).toEqual([{ type: 'deny' }]);
  for (const a of [wt.a, wt.b]) expect(px.sent.filter((s) => s.session === a.id).map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
});

test('single_answer_across_paths: an item answered from its row is never sent again from the strip, the peek or the card', async ({ app, core }) => {
  stripOnTop(core, { below: true }); // needs 107 (ticket 180): the strip is not drawn above the composer
  const { wt, px } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  // The core never hears the answer, so the item stays pending everywhere while every other path is tried.
  px.hold = true;
  await line(app, wt.a).locator('[data-act="allow"]').click();
  await expect.poll(() => px.sent.length).toBe(1);
  const card = app.locator('#waiting-strip .qcard[data-item]');
  await card.locator('.what').click();
  await card.getByRole('button', { name: /Allow once/ }).click();
  await rowOf(app, wt.a).focus();
  await app.keyboard.press('Digit1');
  await app.keyboard.press('Digit2');
  await expect(app.locator('.deccard')).toBeVisible();
  await app.keyboard.press('Digit1');
  await app.waitForTimeout(300);
  expect(px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
});

test('choice_question_choose_and_details: a question shows "choose" and details, no allow', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', QUESTION);
  const q = line(app, wt.a);
  await expect(q.locator('[data-act="choose"]')).toHaveText('choose'); // the ▾ is an Octicon now (STYLE 2026-10-28)
  await expect(q.locator('[data-act="choose"] svg[data-icon="triangle-down"]')).toHaveCount(1);
  await expect(q.locator('[data-act="details"]')).toBeVisible();
  await expect(q.locator('[data-act="allow"]')).toHaveCount(0);
  await q.locator('[data-act="choose"]').click();
  // The option that persists to the agent's config is never offered.
  await expect(q.getByRole('menuitem')).toHaveText(['1 red', '2 blue']);
  await q.getByRole('menuitem', { name: '2 blue' }).click();
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 2');
  expect(px.sent.map((s) => s.answer)).toEqual([{ type: 'choose', index: 1 }]);
});

test('peek_eye_space_esc: about 260 px with what, why, allow and deny; Esc closes it and returns focus; peek allow answers once', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await line(app, wt.a).locator('[data-act="peek"]').click();
  const peek = app.locator('.peek');
  await expect(peek).toBeVisible();
  const box = (await peek.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(240);
  expect(box.width).toBeLessThanOrEqual(280);
  await expect(peek.locator('code')).toContainText('touch out-a');
  await expect(peek.locator('.why2')).not.toBeEmpty();
  await expect(peek.locator('[data-act="allow"]')).toBeVisible();
  await expect(peek.locator('[data-act="deny"]')).toBeVisible();
  // The peek sits beside the tree: no row moved.
  await app.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await expect(rowOf(app, wt.a)).toBeFocused();
  // Space on the focused row opens it; its allow answers once.
  await rowOf(app, wt.b).focus();
  await app.keyboard.press('Space');
  await expect(peek).toBeVisible();
  await peek.locator('[data-act="allow"]').dblclick();
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  expect(px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_once' }]);
  expect(core.read(wt.a.id)).not.toContain('answered');
});

test('panel_jump_card_and_return: details and Enter open the Decisions widget on that session; Esc and Cmd+[ return to the row; card keys answer', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  for (const t of ['b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  await openTab(app, wt.a);
  const side = app.locator('aside.sbar[data-side="right"]');
  // Details: the widget opens in the right sidebar (DECISIONW); the chat keeps its room and its tab, and nothing sits above the composer.
  const pane0 = (await app.locator('.pane').first().boundingBox())!;
  await line(app, wt.b).locator('[data-act="details"]').click();
  await expect(side).toHaveAttribute('data-widget', 'decisions');
  await expect(dcard(app, wt.b).locator('[data-act="allow"]')).toBeFocused();
  expect(await activeTab(app)).toBe(wt.a.id);
  await expect(app.locator('.composer .deccard')).toHaveCount(0);
  await expect(app.locator('.dc-back')).toHaveCount(0);
  const pane = (await app.locator('.pane').first().boundingBox())!;
  expect(pane.height).toBe(pane0.height);
  // Esc returns to the row the jump came from.
  await app.keyboard.press('Escape');
  await expect(block(app, wt.b).locator(':focus')).toHaveCount(1);
  // Look 1117 v3 (item 10): a row click opens that session's tab, as on any row; nothing else takes the focus.
  await rowOf(app, wt.b).click();
  await expect.poll(() => activeTab(app)).toBe(wt.b.id);
  await expect(dcard(app, wt.b).locator('[data-act="allow"]')).not.toBeFocused();
  await openTab(app, wt.a);
  // Enter on the focused row, then Cmd+[.
  await rowOf(app, wt.b).focus();
  await app.keyboard.press('Enter');
  await expect(dcard(app, wt.b).locator('[data-act="allow"]')).toBeFocused();
  await app.keyboard.press('Meta+BracketLeft');
  await expect(block(app, wt.b).locator(':focus')).toHaveCount(1);
  expect(px.sent).toHaveLength(0);
  // In the card, 1 allows; 3 denies. An answer does not navigate.
  await rowOf(app, wt.b).focus();
  await app.keyboard.press('Digit2');
  await expect(dcard(app, wt.b).locator('[data-act="allow"]')).toBeFocused();
  await app.keyboard.press('Digit1');
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  await line(app, wt.c).locator('[data-act="details"]').click();
  await expect(dcard(app, wt.c).locator('[data-act="allow"]')).toBeFocused();
  await app.keyboard.press('Digit3');
  await expect.poll(() => px.sent.length).toBe(2);
  expect(await activeTab(app)).toBe(wt.a.id);
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([
    [wt.b.id, 'allow_once'],
    [wt.c.id, 'deny'],
  ]);
});

// Security round 2 (ticket 70): the focus restore follows the *prompt*, not just the kind. A different decision that arrives
// when the focused one leaves must never inherit the focus, or one Enter would answer a prompt the user did not read.
for (const risky of [false, true]) {
  test(`different_prompt_never_inherits_focus (${risky ? 'risky' : 'ordinary'}): the focused Allow's item leaves, another command arrives in the same snapshot: no answer button is focused and Enter, Space and 1 send nothing`, async ({ app, core }) => {
    const { wt, px } = await setup(app, core, ['a']);
    await noFront(app); // ticket 1030: these check the Decisions card
    if (risky) px.risky.add('wt-a');
    await ask(app, wt.a, 'a', PERMISSION(risky ? 'rm -rf build' : 'touch out-a'));
    await line(app, wt.a).locator('[data-act="details"]').click();
    const card = dcard(app, wt.a);
    await expect(card.locator('[data-act="allow"]').or(card.locator('[data-act="deny"]')).first()).toBeFocused();
    await card.locator('[data-act="allow"]').focus();
    // A is gone (answered elsewhere) and B, asking for something else, arrives in the same snapshot.
    px.patch((d) => [{ ...d, id: 'other-prompt', text: 'rm -rf /', observed_at: (d.observed_at as number) + 1 }]);
    await expect(card.locator('.dc-item[data-item="other-prompt"]')).toHaveCount(1);
    await expect(card.locator('[data-act]:focus')).toHaveCount(0);
    for (const key of ['Enter', 'Space', 'Digit1']) await app.keyboard.press(key);
    await app.waitForTimeout(300);
    expect(px.sent).toEqual([]);
  });
}

test('same_prompt_keeps_focus: the same prompt re-filed under a new id (a terminal refit) still keeps the focus on the same button (ticket 70)', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await noFront(app); // ticket 1030: these check the Decisions card
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await line(app, wt.a).locator('[data-act="details"]').click();
  const card = dcard(app, wt.a);
  await expect(card.locator('[data-act="allow"]')).toBeFocused();
  await card.locator('[data-act="deny"]').focus();
  // Same text, a little differently wrapped, as a refit redraws it.
  px.patch((d) => [{ ...d, id: 'refiled', text: `  ${d.text.replace(/ /g, '  ')}\n` }]);
  await expect(card.locator('.dc-item[data-item="refiled"] [data-act="deny"]')).toBeFocused();
  expect(px.sent).toEqual([]);
});

test('risky_permission_has_no_inline_or_peek_allow: destructive, outside-folder, network and unclassifiable requests', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b', 'c', 'd']);
  await noFront(app); // ticket 1030: these check the Decisions card
  ['a', 'b', 'c', 'd'].forEach((t) => px.risky.add(`wt-${t}`));
  const cmds: Record<string, string> = { a: 'rm -rf build', b: 'cat /etc/passwd', c: 'curl https://example.com', d: 'ls' };
  for (const t of Object.keys(cmds)) await ask(app, wt[t], t, PERMISSION(cmds[t]));
  for (const t of Object.keys(cmds)) {
    const q = line(app, wt[t]);
    await expect(q.locator('.warn')).toHaveText('Caution');
    await expect(q.locator('[data-act="allow"]')).toHaveCount(0);
    await expect(q.locator('[data-act="deny"]')).toBeVisible();
    // Key 1 on the row does nothing.
    await rowOf(app, wt[t]).focus();
    await app.keyboard.press('Digit1');
    // The peek has no allow: it opens the panel.
    await q.locator('[data-act="peek"]').click();
    await expect(app.locator('.peek [data-act="allow"]')).toHaveCount(0);
    await expect(app.locator('.peek [data-act="details"]')).toHaveText('Open in panel');
    await app.keyboard.press('Escape');
  }
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  // The card allows only by focus then Enter: a click (and Space) only explain.
  await line(app, wt.a).locator('[data-act="details"]').click();
  const allow = dcard(app, wt.a).locator('[data-act="allow"]');
  await expect(dcard(app, wt.a).locator('[data-act="deny"]')).toBeFocused();
  await expect(allow).toHaveText('Allow (press Enter)');
  await app.keyboard.press('Digit1');
  await allow.click();
  await expect(dcard(app, wt.a)).toContainText('press Enter');
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await allow.focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  expect(px.sent.map((s) => [s.session, s.answer])).toEqual([[wt.a.id, { type: 'allow_once' }]]);
});

test('dont_ask_again_only_in_card_by_mouse: absent from row and peek; no key reaches it; one click sends it once', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  // The core offers it only on a safe request whose prompt has a session-only option (decision_answers.rs); a fake
  // cannot give hook data, so the proxy adds the field.
  const label = 'Yes, allow all edits during this session';
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  px.patch((d) => void (d.kind === 'permission' && (d.allow_always = label)));
  await expect(line(app, wt.a).locator('[data-act="allow-always"]')).toHaveCount(0);
  await line(app, wt.a).locator('[data-act="peek"]').click();
  await expect(app.locator('.peek [data-act="allow-always"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await line(app, wt.a).locator('[data-act="details"]').click();
  const always = app.locator('.deccard [data-act="allow-always"]');
  await expect(always).toBeVisible();
  await expect(always).toHaveAttribute('tabindex', '-1');
  await expect(always).toHaveAttribute('title', new RegExp(label));
  // Keyboard: Tab never lands on it, and Enter or Space on it does nothing.
  await always.focus();
  await app.keyboard.press('Enter');
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await always.dblclick();
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_always' }]);
});

test('deny_instruction_is_sent_once: from the row and the card; empty sends none; double click or Enter then click send one', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await line(app, wt.a).locator('[data-act="deny"]').click();
  const input = block(app, wt.a).locator('.dn input');
  await expect(block(app, wt.a).locator('[data-act="deny-send"]')).toBeDisabled();
  await input.fill('use cargo check instead');
  await input.press('Enter');
  await block(app, wt.a).locator('[data-act="deny-send"]').click({ timeout: 500 }).catch(() => {}); // gone once sent
  // The card: a note, then Enter and a click on Deny, sends one deny with it.
  await line(app, wt.b).locator('[data-act="details"]').click();
  await expect(dcard(app, wt.b).locator('[data-act="allow"]')).toBeFocused(); // the card is up and holds the focus (a re-file keeps it)
  // Hold the answer (the core never hears it): the click then meets the item shown, whatever id the core files it under.
  px.hold = true;
  const note = dcard(app, wt.b).locator('.dc-note');
  await note.fill('run the tests first');
  await note.press('Enter');
  await dcard(app, wt.b).locator('[data-act="deny"]').click({ timeout: 500 }).catch(() => {});
  await expect.poll(() => px.sent.map((s) => [s.session, s.answer])).toEqual([
    [wt.a.id, { type: 'deny_with', text: 'use cargo check instead' }],
    [wt.b.id, { type: 'deny_with', text: 'run the tests first' }],
  ]);
});

test('several_pending_show_count_no_allow_all: three from one session show "3", details only', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  // The fake shows one prompt at a time; the proxy adds two more of the same session.
  px.patch((d) => (d.kind === 'permission' ? [d, { ...d, id: `${d.id}-2`, observed_at: (d.observed_at as number) + 1 }, { ...d, id: `${d.id}-3`, observed_at: (d.observed_at as number) + 2 }] : undefined));
  await expect(rowOf(app, wt.a).locator('.two')).toHaveText('3');
  const q = line(app, wt.a);
  await expect(q.locator('[data-act]')).toHaveCount(2); // details and peek
  await expect(q.locator('[data-act="details"]')).toBeVisible();
  await q.locator('[data-act="peek"]').click();
  await expect(app.locator('.peek [data-act="allow"], .peek [data-act="deny"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await rowOf(app, wt.a).focus();
  await app.keyboard.press('Digit1');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await q.locator('[data-act="details"]').click();
  await expect(app.locator('.deccard .dc-item')).toHaveCount(3);
  for (const b of await app.locator('.deccard button').allInnerTexts()) expect(b).not.toMatch(/\ball\b/i);
});

// Q9 pop-J22-1: a session whose background task note is listed before its permission still gets Allow and Deny, and key 1
// answers the permission; the line names the permission, not the note with "+1 more".
test('background_note_beside_an_ask_keeps_its_answers', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  let ask1 = '';
  px.patch((d) => (d.kind === 'permission' ? ((ask1 = d.id), [{ ...d, id: `bg-${d.id}`, kind: 'background', text: 'Background task still running', observed_at: (d.observed_at as number) - 1 }, d]) : undefined));
  const q = line(app, wt.a);
  await expect(q).toHaveAttribute('data-item', /^(?!bg-)/);
  await expect(q.locator('[data-act="allow"]')).toBeVisible();
  await expect(q.locator('[data-act="deny"]')).toBeVisible();
  await expect(q.locator('.qt')).not.toContainText('more');
  await rowOf(app, wt.a).focus();
  await app.keyboard.press('Digit1');
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  expect(px.sent.map((s) => s.item)).toEqual([ask1]);
});

test('answered_elsewhere_clears_row_badge_and_strip: an answer typed in the agent terminal clears all three together', async ({ app, core }) => {
  stripOnTop(core, { below: true }); // needs 107 (ticket 180): the strip is not drawn above the composer
  const { wt } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const pill = app.locator('.grp[data-project="repo"] .row.head .cstrip > .sg[data-tone="o"]'); // ticket 388: the orange strip colour, `data-n` its count
  await expect(pill).toHaveAttribute('data-n', '1');
  await expect(app.locator('#waiting-strip .qcard[data-item]')).toHaveCount(1);
  // The terminal fixture: the user answers in the agent's own prompt.
  await openTab(app, wt.a);
  await app.mouse.move(900, 600);
  core.cli('session', 'send-keys', wt.a.id, '1', 'enter'); // lane w102: send-text waits out a start question
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  await expect.poll(async () => [await line(app, wt.a).count(), await pill.count(), await app.locator('#waiting-strip .qcard[data-item]').count()]).toEqual([0, 0, 0]);
});

test('rows_do_not_move_under_pointer_or_focus: a new decision and a reorder wait while the pointer is in the tree; the badge bumps at once', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await app.locator('.grp[data-project="repo"] .row.head .n').hover();
  const before = await boxes(app);
  const pill = app.locator('.grp[data-project="repo"] .row.head .cstrip > .sg[data-tone="o"]'); // ticket 388: the orange strip colour, `data-n` its count
  show(wt.c.cwd, 'go-c', PERMISSION('touch out-c'));
  // TREEHEAD-FREEZE (tree4 r3, owner 2026-11-02): the live count is 2 at once (the head's label), the pill the head draws waits with the head.
  await expect(app.locator('.grp[data-project="repo"] .row.head .r')).toHaveAttribute('aria-label', /2 waiting/, { timeout: 8000 });
  await expect(pill).toHaveAttribute('data-n', '1');
  await app.waitForTimeout(600);
  await expect(line(app, wt.c)).toHaveCount(0);
  expect(unmoved(before, await boxes(app))).toEqual([]);
  // Focus in the tree holds too, after the pointer leaves.
  await rowOf(app, wt.a).focus();
  await app.mouse.move(900, 600);
  await app.waitForTimeout(600);
  await expect(line(app, wt.c)).toHaveCount(0);
  await expect(rowOf(app, wt.a)).toBeFocused();
  // Both out: the new line comes in.
  await app.locator('.cbox textarea').focus();
  await expect(line(app, wt.c)).toBeVisible();
  await expect(pill).toHaveAttribute('data-n', '2');
});

// Fixed, not derived from the core's id: a re-issued item changes that id mid-test.
const NEW_ITEM = 'frozen-new';

test('frozen_line_pins_its_item: a new item of the session never takes the place of the one under focus before 1 is pressed', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  const shown = await line(app, wt.a).getAttribute('data-item');
  await rowOf(app, wt.a).focus();
  // While focus is in the tree the session's item is answered elsewhere and a new one replaces it.
  px.patch((d) => [{ ...d, id: NEW_ITEM, observed_at: (d.observed_at as number) + 1 }]);
  await app.waitForTimeout(400);
  await expect(line(app, wt.a)).toHaveAttribute('data-item', shown!);
  await app.keyboard.press('Digit1');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await expect(app.locator('.grp[data-project="repo"] .head .chip')).toHaveText('new 1');
  // Out of the tree the new item takes the line.
  await app.locator('.cbox textarea').focus();
  await expect(line(app, wt.a)).toHaveAttribute('data-item', NEW_ITEM);
});

// (v25-new-tab, needs 213: worktree rows only; the main folder's idle session has a row of its own, hidden by the fold like these.)
test('fold_hides_only_quiet_rows: folding a project keeps its your-turn rows', async ({ app, core }) => {
  const { wt } = await setup(app, core, ['a', 'b']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await expect(app.locator('.grp[data-project="repo"] .row.wt2:not([data-menu="treerow"])')).toHaveCount(2);
  await app.locator('.grp[data-project="repo"] .row.head .chev').click();
  await app.mouse.move(900, 600);
  await app.locator('.cbox textarea').focus();
  await expect(app.locator('.grp[data-project="repo"] .row.wt2:not([data-menu="treerow"])')).toHaveCount(1);
  await expect(rowOf(app, wt.a)).toBeVisible();
  await expect(line(app, wt.a)).toBeVisible();
});

test('esc_and_answer_return_to_previous_session: Esc in an open peek closes only the peek; an answer in the widget keeps the tab', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  for (const t of ['b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  await openTab(app, wt.a);
  await line(app, wt.b).locator('[data-act="details"]').click();
  await expect(dcard(app, wt.b)).toBeVisible();
  await line(app, wt.c).locator('[data-act="peek"]').click();
  await expect(app.locator('.peek')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.locator('.peek')).toHaveCount(0);
  expect(await activeTab(app)).toBe(wt.a.id);
  await expect(dcard(app, wt.b)).toBeVisible();
  await dcard(app, wt.b).locator('[data-act="allow"]').click();
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  expect(await activeTab(app)).toBe(wt.a.id);
});

test('keyboard_only_and_axe: reach a row, peek, deny with an instruction, jump and return by keys; no serious axe violations', async ({ app, core, browserName }) => {
  const { wt, px } = await setup(app, core);
  for (const t of ['b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  await openTab(app, wt.a);
  // Reach the row by Tab alone.
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // WebKit's Tab skips buttons (no "Tab to links"): there a key press then programmatic focus stands in, as in tree-rows.spec.
  if (browserName === 'webkit') (await app.keyboard.press('Shift'), await rowOf(app, wt.b).focus());
  // V2.5-61 (ticket 194): one tree row is in the Tab order (roving tabindex); Tab reaches it, the arrows reach the rest.
  const onRow = () => app.evaluate(() => !!document.activeElement?.closest('.tree') && !!document.activeElement?.matches('button.row.wt2'));
  for (let i = 0; i < 80 && !(await onRow()); i++) await app.keyboard.press('Tab');
  for (const key of ['ArrowDown', 'ArrowUp']) for (let i = 0; i < 20 && !(await rowOf(app, wt.b).evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press(key);
  await expect(rowOf(app, wt.b)).toBeFocused();
  await app.keyboard.press('Space');
  await expect(app.locator('.peek')).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(app.locator('.peek')).toHaveCount(0);
  await expect(rowOf(app, wt.b)).toBeFocused();
  await app.keyboard.press('Digit3');
  await expect(block(app, wt.b).locator('.dn input')).toBeFocused();
  await app.keyboard.type('try a dry run');
  await app.keyboard.press('Enter');
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'deny_with', text: 'try a dry run' }]);
  await rowOf(app, wt.c).focus();
  await app.keyboard.press('Enter');
  await expect(dcard(app, wt.c).locator('[data-act="allow"]')).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(block(app, wt.c).locator(':focus')).toHaveCount(1);
  // axe moves focus while it scans, so it runs after the keyboard path: the tree, the card and the peek.
  const axe = async (include: string) => (await new AxeBuilder({ page: app }).include(include).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  // The answered line leaves first (its fade-out would be scanned mid-way); then the rest at their final colours.
  await app.mouse.move(900, 600);
  await app.locator('.cbox textarea').focus();
  await expect(app.locator('.tree .q.answered')).toHaveCount(0, { timeout: 8000 });
  await app.locator('.tree').evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).filter((x) => x.effect?.getComputedTiming().iterations !== Infinity).map((x) => x.finished.catch(() => {}))));  // a cancelled one (its line left) is done too
  expect(await axe('.tree')).toEqual([]);
  await line(app, wt.c).locator('[data-act="details"]').click();
  await expect(dcard(app, wt.c)).toBeVisible();
  expect(await axe('aside.sbar[data-side="right"]')).toEqual([]);
  await line(app, wt.c).locator('[data-act="peek"]').click();
  await expect(app.locator('.peek')).toBeVisible();
  expect(await axe('.peek')).toEqual([]);
});

plain('no_pr_button_no_coach_mark: the new files have no coach mark, tutorial or tour', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  for (const f of ['tree/DecisionLine.tsx', 'tree/decisions.ts', 'chat/DecisionCard.tsx', 'chat/decision-card.css']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    expect(text, f).not.toMatch(/coach|tutorial|\btour\b|onboard/i);
  }
});

// Ticket 559 (F1, found by the 552 sweep): a focused input does not clip a placeholder with an ellipsis, so the longest
// language's words must fit the box as it is. Measured with the box's own font against its content width, per language.
test('deny_placeholder_fits_559: the Deny box placeholder is not clipped in any of the 8 languages', async ({ app, core }) => {
  const { wt } = await setup(app, core, ['a']);
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await line(app, wt.a).locator('[data-act="deny"]').click();
  const input = block(app, wt.a).locator('.dn input');
  await expect(input).toBeFocused();
  const words = Object.fromEntries(Object.entries({ en: decisions.en, ko: decisions.ko, ja: decisions.ja, 'zh-Hans': decisions.zhHans, 'zh-Hant': decisions.zhHant, es: decisions.es, fr: decisions.fr, pt: decisions.pt }).map(([k, v]) => [k, v['decisions.denyNotePh']]));
  const widths = await input.evaluate((el: HTMLInputElement, ws) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = cs.font;
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { room, text: Object.fromEntries(Object.entries(ws).map(([k, w]) => [k, ctx.measureText(w).width])) };
  }, words);
  for (const [lang, w] of Object.entries(widths.text)) expect(w, `${lang} placeholder ${Math.round(w)}px in ${Math.round(widths.room)}px`).toBeLessThanOrEqual(widths.room);
});
