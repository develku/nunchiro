// V2-8e / decisionw (owner DECISIONW, NODUP, FRAME, RIGHTBAR 2026-10-28): the decision card left the chat; the
// "Decisions" widget of the D5b library holds every session's pending items and the only risky allow. A real core and
// fake agents; the window's socket is proxied to record answers (decision-rows-seed.ts).
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { fakes, gitRepo, noFront, pending, PERMISSION, proxy, show } from './decision-rows-seed';
import { at, barEnd, card, drag, icon, lib, names, sidebar, startEdit, toast, zone } from './d5b';

type Agent = { id: string; cwd: string };
async function setup(app: Page, core: Core, names: string[] = ['a', 'b', 'c']) {
  fakes(core);
  const p = gitRepo(core, 'repo');
  const wt: Record<string, Agent> = Object.fromEntries(names.map((t) => [t, core.agent(p, `wt-${t}`, `go-${t}`, true)]));
  const px = await proxy(app);
  await openWindow(app);
  return { wt, px };
}
const line = (app: Page, a: Agent) => app.locator(`.q[data-line="${a.id}"]`);
const ask = async (app: Page, a: Agent, t: string, screen: string) => {
  show(a.cwd, `go-${t}`, screen);
  await expect(line(app, a)).toBeVisible({ timeout: 8000 });
};
/** The item shown is one the core holds now, and has been for 600 ms: opening the sidebar refits the terminal in two or
 *  three steps about 100 ms apart, and a redraw re-files the prompt under a new id (replacing its buttons and their
 *  focus). A check that passes between two steps leaves the next click answering an id the core has dropped. */
const settled = (app: Page, core: Core) => {
  let last: string | null = null;
  let since = 0;
  return expect
    .poll(async () => {
      const shown = await app.locator('.deccard .dc-item').first().getAttribute('data-item');
      const held = pending(core).some((d) => d.id === shown);
      if (!held || shown !== last) [last, since] = [held ? shown : null, Date.now()];
      return held && Date.now() - since >= 600;
    }, { intervals: [150] })
    .toBe(true);
};
/** Opens the jump from a row's details once and waits for `target` to hold focus (a re-filed prompt keeps its focus, ticket 70). */
const jumpFocus = async (app: Page, a: Agent, target: Locator) => {
  await line(app, a).locator('[data-act="details"]').click();
  await expect(target).toBeFocused();
};
const side = (app: Page) => sidebar(app, 'right');
const open = async (app: Page) => {
  await icon(app, 'right', 'Decisions').click();
  await expect(side(app)).toHaveAttribute('data-widget', 'decisions');
};

test('no_decision_card_in_chat: a jump from a row puts no answer control in the chat or composer zone', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await line(app, wt.b).locator('[data-act="details"]').click();
  await expect(side(app).locator('.dc-item')).toHaveCount(1);
  await expect(app.locator('.deccard .dc-back')).toHaveCount(0);
  for (const zoneId of ['terminal', 'composer', 'waiting']) await expect(zone(app, zoneId).locator('.dc-item, [data-act="allow"], [data-act="deny"]')).toHaveCount(0);
  await expect(app.locator('.pane .dc-item, .composer .dc-item')).toHaveCount(0);
});

test('decisions_widget_in_library_and_default_frame: library card (search 결정), Right bar Board, Decisions, Diff, Artifacts, sidebar closed', async ({ app }) => {
  await openWindow(app);
  expect((await names(app, 'right')).filter((n) => n !== 'Layout' && n !== 'Settings')).toEqual(['Board', 'Decisions', 'Terminal', 'Browser', 'Diff', 'Artifacts', 'History', 'Schedules']); // ticket 1073: History placed after Artifacts, Schedules after it; ticket 993: Schedules joins the next free slot
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
  expect(await app.locator('nav[data-bar="right"] button.ai[aria-pressed="true"]').count()).toBe(0);
  // Ticket 1041: the icon has no label; its name is the tooltip.
  await expect(icon(app, 'right', 'Decisions')).toHaveAttribute('data-tip', /Decisions/);
  await startEdit(app);
  await lib(app).getByLabel('Search widgets').fill('결정');
  await expect(card(app, 'decisions')).toBeVisible();
  await expect(card(app, 'decisions')).toContainText('Decisions');
});

test('right_bar_default_frame: Diff opens in the right sidebar and a second click closes it; no Preview', async ({ app }) => {
  await openWindow(app);
  expect(await names(app, 'right')).not.toContain('Preview');
  await icon(app, 'right', 'Diff').click();
  await expect(side(app)).toHaveAttribute('data-widget', 'diff');
  await icon(app, 'right', 'Diff').click();
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
});

test('decisions_lists_all_sessions: grouped by session, oldest first; one click from fresh; a quiet empty state; a teammate seat names its project', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  await open(app); // 1 click
  await expect(side(app)).toContainText('Nothing waiting');
  await ask(app, wt.c, 'c', PERMISSION('touch out-c'));
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  const groups = side(app).locator('[data-session]');
  await expect(groups).toHaveCount(2);
  expect(await groups.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session))).toEqual([wt.c.id, wt.b.id]);
  await expect(groups.first()).toContainText('wt-c');
  await expect(side(app)).not.toContainText('Nothing waiting');
  // Look 1117 v10 Home S3-2: every project's lead is "Lead", so a teammate seat outside Home says which project.
  px.patch((_, s) => void (s.label === 'wt-b' && Object.assign(s, { teammate: 'lead-1' })));
  await expect(groups.last().locator('.dwh b')).toHaveText('wt-b · repo');
  await expect(groups.first().locator('.dwh b')).toHaveText('wt-c');
});

test('widget_safe_allow_and_deny: key 1 allows and key 3 denies through the same answer the old card sent', async ({ app, core }) => {
  const { wt, px } = await setup(app, core);
  for (const t of ['b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  await open(app);
  await settled(app, core);
  const item = (a: Agent) => side(app).locator(`[data-session="${a.id}"] .dc-item`);
  await item(wt.b).locator('[data-act="allow"]').focus();
  await app.keyboard.press('Digit1');
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  await item(wt.c).locator('[data-act="deny"]').focus();
  await app.keyboard.press('Digit3');
  await expect.poll(() => px.sent.length).toBe(2);
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([
    [wt.b.id, 'allow_once'],
    [wt.c.id, 'deny'],
  ]);
});

test('widget_risky_allow_focus_enter_only: click and key 1 send nothing; deny leads and is focused; focus allow + Enter allows; no "don\'t ask again"', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  px.risky.add('wt-a');
  await ask(app, wt.a, 'a', PERMISSION('rm -rf build'));
  px.patch((d) => void (d.kind === 'permission' && (d.allow_always = 'Yes, allow all edits during this session')));
  const item = side(app).locator('.dc-item.risky');
  await jumpFocus(app, wt.a, item.locator('[data-act="deny"]'));
  await expect(item.locator('.warn')).toHaveText('Caution');
  await expect(item.locator('[data-act="allow-always"]')).toHaveCount(0);
  const allow = item.locator('[data-act="allow"]');
  await app.keyboard.press('Digit1');
  await allow.click();
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await settled(app, core);
  await allow.focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => core.read(wt.a.id)).toContain('answered 1');
  expect(px.sent.map((s) => [s.session, s.answer])).toEqual([[wt.a.id, { type: 'allow_once' }]]);
});

test('dont_ask_again_mouse_only_here: clickable in the widget, no key reaches it, absent from row and peek', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await noFront(app); // ticket 1030: this checks the Decisions card
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  px.patch((d) => void (d.kind === 'permission' && (d.allow_always = 'Yes, allow all edits during this session')));
  await expect(line(app, wt.a).locator('[data-act="allow-always"]')).toHaveCount(0);
  await line(app, wt.a).locator('[data-act="peek"]').click();
  await expect(app.locator('.peek [data-act="allow-always"]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await open(app);
  await settled(app, core);
  const always = side(app).locator('[data-act="allow-always"]');
  await expect(always).toHaveAttribute('tabindex', '-1');
  await always.focus();
  await app.keyboard.press('Enter');
  await app.keyboard.press('Space');
  await app.waitForTimeout(300);
  expect(px.sent).toHaveLength(0);
  await always.click();
  await expect.poll(() => px.sent.map((s) => s.answer)).toEqual([{ type: 'allow_always' }]);
});

test('row_jump_opens_widget: details and Enter open the sidebar on that session first item; Esc and Meta+[ return to the row', async ({ app, core }) => {
  const { wt } = await setup(app, core);
  for (const t of ['b', 'c']) await ask(app, wt[t], t, PERMISSION(`touch out-${t}`));
  const row = (a: Agent) => app.locator('.sess').filter({ has: line(app, a) }).locator('.row.wt2');
  const first = (a: Agent) => side(app).locator(`[data-session="${a.id}"] .dc-item`).first().locator('[data-act="allow"], [data-act="deny"]').first();
  await line(app, wt.c).locator('[data-act="details"]').click();
  await expect(first(wt.c)).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(row(wt.c).or(line(app, wt.c)).first()).toBeVisible();
  await expect(app.locator('.sess').filter({ has: line(app, wt.c) }).locator(':focus')).toHaveCount(1);
  // Look 1117 v3 (item 10): a row click opens the session; the jump is the line's details button, Enter or 2.
  await line(app, wt.b).locator('[data-act="details"]').click();
  await expect(first(wt.b)).toBeFocused();
  await app.keyboard.press('Meta+BracketLeft');
  await expect(app.locator('.sess').filter({ has: line(app, wt.b) }).locator(':focus')).toHaveCount(1);
  await row(wt.b).focus();
  await app.keyboard.press('Enter');
  await expect(first(wt.b)).toBeFocused();
});

test('decisions_required: no ✕, the remove area refuses with the reason, it moves to the Left bar and into a zone and keeps working', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  await noFront(app); // ticket 1030: this checks the Decisions card
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await startEdit(app);
  await expect(app.getByRole('button', { name: /Remove Decisions/ })).toHaveCount(0);
  await drag(app, icon(app, 'right', 'Decisions'), app.locator('[data-remove-area]'), { release: false });
  await expect(app.locator('.dropprev[data-error="true"]')).toContainText('Decisions is required because it holds the risky Allow answers');
  await app.mouse.up();
  await expect(toast(app)).toContainText('Decisions is required because it holds the risky Allow answers');
  expect(await names(app, 'right')).toContain('Decisions');
  await drag(app, icon(app, 'right', 'Decisions'), await barEnd(app, 'left'));
  expect(await names(app, 'left')).toContain('Decisions');
  await drag(app, icon(app, 'left', 'Decisions'), await at(app, 'terminal', 0.92, 0.5));
  await expect(zone(app, 'decisions').locator('.wg[data-widget="decisions"]')).toBeVisible();
  await expect(zone(app, 'decisions').getByRole('button', { name: /Remove Decisions/ })).toHaveCount(0);
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done', exact: true }).click();
  await icon(app, 'left', 'Tree').click();
  const item = app.locator('.wg[data-widget="decisions"] .dc-item');
  await jumpFocus(app, wt.a, item.locator('[data-act="allow"]'));
  await app.keyboard.press('Digit1');
  await expect.poll(() => px.sent.map((s) => s.answer.type)).toEqual(['allow_once']);
});

test('axe_decisions: no serious violations with the widget open', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  px.risky.add('wt-b');
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await ask(app, wt.b, 'b', PERMISSION('rm -rf build'));
  await open(app);
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const bad = (await new AxeBuilder({ page: app }).include('aside.sbar[data-side="right"]').analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad, scheme).toEqual([]);
  }
});

/** The fake agent also draws a second prompt, once `go-<t>-next` exists (after its first answer). Between the two it has
 *  nothing to ask, so a resize redraws nothing: the fake's own WINCH trap would put the answered prompt back on screen,
 *  and the core would file it again (the jump after the answer refits the terminal when the side pane is still open). */
function twoPrompts(core: Core) {
  const fake = path.join(core.home, 'bin/claude');
  const src = fs.readFileSync(fake, 'utf8');
  const tail = 'sleep 600\n';
  if (!src.endsWith(tail)) throw new Error('fake agent changed: update twoPrompts');
  fs.writeFileSync(fake, src.slice(0, -tail.length) + 'trap : WINCH\nwhile [ ! -s "$go-next" ]; do sleep 0.02; done\ngo="$go-next"; trap draw WINCH; draw\nuntil read x; do :; done\nprintf "second %s\\r\\n" "$x"\nsleep 600\n', { mode: 0o700 });
}
const composer = (app: Page) => app.locator('.cbox textarea');
const front = async (app: Page, a: Agent) => {
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect.poll(() => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab')).toBe(a.id);
};

// Round 2 (Opus security review): a jump grants focus once. A later prompt of that session must never take focus from
// what the user is doing and leave an Enter, Space or 1 away from answering an item they never saw.
test('answer_then_new_item_keeps_composer_focus: after an answer from a jump, a new item for the session never takes the composer focus', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  await front(app, wt.a); // ticket 1030: b asks in the background, a's composer takes the keys
  twoPrompts(core);
  await ask(app, wt.b, 'b', PERMISSION('touch first'));
  const allow = side(app).locator('.dc-item [data-act="allow"]');
  await jumpFocus(app, wt.b, allow);
  await settled(app, core);
  await allow.click();
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  await expect(side(app).locator('.dc-item')).toHaveCount(0);
  await composer(app).focus();
  show(wt.b.cwd, 'go-b-next', PERMISSION('touch second'));
  await expect(side(app).locator('.dc-item')).toHaveCount(1, { timeout: 8000 });
  // Sample the focus for 1.2 s: it must never sit on the new item's buttons (a focus theft that ends early still counts).
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    seen.add(await app.evaluate(() => { const e = document.activeElement as HTMLElement; return e.dataset.act ?? e.id ?? e.tagName; }));
    await app.waitForTimeout(40);
  }
  expect([...seen].filter((x) => ['allow', 'deny', 'choose'].includes(x))).toEqual([]);
  await expect(composer(app)).toBeFocused();
  for (const key of ['Enter', 'Space', 'Digit1']) await app.keyboard.press(key);
  await app.waitForTimeout(400);
  expect(px.sent.map((x) => x.answer.type)).toEqual(['allow_once']); // only the first, answered by the click
  await expect(side(app).locator('.dc-item [data-act="allow"]')).not.toBeFocused();
});

test('reopen_sidebar_does_not_refocus_allow: closing and reopening the sidebar during a jump moves no focus onto Allow', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  await front(app, wt.a); // ticket 1030: b asks in the background, a's composer takes the keys
  await ask(app, wt.b, 'b', PERMISSION('touch out-a'));
  await jumpFocus(app, wt.b, side(app).locator('.dc-item [data-act="allow"]'));
  await composer(app).focus();
  await icon(app, 'right', 'Decisions').click(); // closes
  await expect(app.locator('aside.sbar[data-side="right"]')).toHaveCount(0);
  await composer(app).focus();
  await icon(app, 'right', 'Decisions').click(); // reopens
  await expect(side(app).locator('.dc-item')).toHaveCount(1);
  await composer(app).focus();
  await app.waitForTimeout(600);
  await expect(composer(app)).toBeFocused();
  for (const key of ['Enter', 'Space', 'Digit1']) await app.keyboard.press(key);
  await app.waitForTimeout(400);
  expect(px.sent).toHaveLength(0);
});

// Round 3 (Opus re-review): a jump to a session with nothing waiting draws no card, so nothing used its focus request;
// it stayed open and the session's next prompt took the focus onto Allow.
test('answered_row_jump_never_focuses_later_item: a jump from an answered row, then a new prompt, never moves focus onto its buttons', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a', 'b']);
  await front(app, wt.a); // ticket 1030: b asks in the background, a's composer takes the keys
  twoPrompts(core);
  await ask(app, wt.b, 'b', PERMISSION('touch first'));
  await line(app, wt.b).locator('[data-act="allow"]').click(); // answered from the row
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  await expect.poll(() => pending(core).length).toBe(0);
  // The answered row stays while the pointer is in the tree; clicking it still starts a jump (to a session with nothing waiting).
  const answered = app.locator('.sess').filter({ has: line(app, wt.b) }).locator('.row.wt2');
  await answered.focus(); // look 1117 v3 (item 10): a click opens the session; Enter is the jump
  await app.keyboard.press('Enter');
  await expect(side(app)).toHaveAttribute('data-widget', 'decisions');
  await expect(side(app).locator('.dc-item')).toHaveCount(0);
  await composer(app).focus();
  show(wt.b.cwd, 'go-b-next', PERMISSION('touch second'));
  await expect(side(app).locator('.dc-item')).toHaveCount(1, { timeout: 8000 });
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    seen.add(await app.evaluate(() => { const e = document.activeElement as HTMLElement; return e.dataset.act ?? e.id ?? e.tagName; }));
    await app.waitForTimeout(40);
  }
  expect([...seen].filter((x) => ['allow', 'deny', 'choose'].includes(x))).toEqual([]);
  await expect(composer(app)).toBeFocused();
  for (const key of ['Enter', 'Space', 'Digit1']) await app.keyboard.press(key);
  await app.waitForTimeout(400);
  expect(px.sent.map((x) => x.answer.type)).toEqual(['allow_once']); // only the row's own answer
});

test('decisions_card_korean_701: a Korean window reads the card why line and its age from the catalogue', async ({ app, core }) => {
  const { wt } = await setup(app, core, ['b']);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  await noFront(app); // ticket 1030: this checks the Decisions card
  show(wt.b.cwd, 'go-b', PERMISSION('touch out-b'));
  await expect(line(app, wt.b)).toBeVisible({ timeout: 8000 });
  await app.getByRole('navigation', { name: '오른쪽 바' }).getByRole('button', { name: '결정', exact: true }).click();
  await expect(side(app)).toHaveAttribute('data-widget', 'decisions');
  const card = side(app).locator(`[data-session="${wt.b.id}"]`);
  // Before ticket 701 both were English: "Risky: it may delete…" / "The agent asks before it runs this." and "<1 min".
  await expect(card.locator('.dc-why')).toHaveText(/^이유\s*(위험: 파일을 삭제하거나 폴더 밖이나 네트워크에 접근할 수 있습니다\. 또는 Nunchiro가 요청을 읽지 못했습니다\.|에이전트가 이것을 실행하기 전에 묻습니다\.)$/);
  await expect(card.locator('.tm').first()).toHaveText('1분 미만');
});

// Look v31 a S2-1: the Home seat's mail search read as risky, its card named only the query, and a mouse click on its
// allow did nothing (a risky card's allow is focus + Enter only, by rule).
const MAIL = { text: '{"query":"in:inbox"}', tool: 'mcp__claude_ai_Gmail__search_threads' };
test('v31_a_mail_read_card: a read tool the core marks safe names its server and tool, says it only reads, and a mouse click on Allow answers it', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['b']);
  await noFront(app); // ticket 1030: this checks the Decisions card
  px.patch((d) => void (d.kind === 'permission' && Object.assign(d, MAIL)));
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await expect(line(app, wt.b)).toContainText('Gmail · search threads · in:inbox'); // the tree row's line names it too
  await open(app);
  await settled(app, core);
  const item = side(app).locator(`[data-session="${wt.b.id}"] .dc-item`);
  await expect(item.locator('.warn')).toHaveCount(0);
  await expect(item.locator('.dc-what')).toHaveText(/^What\s*Gmail · search threads · in:inbox$/);
  await expect(item.locator('.dc-why')).toHaveText(/^Why\s*Read only: it reads from Gmail and changes nothing\.$/);
  await expect(item.locator('[data-act="allow"]')).toHaveText('Allow');
  await item.locator('[data-act="allow"]').click(); // a real mouse click, no focus + Enter
  await expect.poll(() => core.read(wt.b.id)).toContain('answered 1');
  expect(px.sent.map((s) => [s.session, s.answer.type])).toEqual([[wt.b.id, 'allow_once']]);
});

// Ticket 1130 S1: an outward call asks in every session; its card names the kind the core set ("Send mail") beside the
// caution, and a card with no kind shows none.
test('t1130_outward_card_names_its_kind: a mail send card says "Send mail" and keeps the caution', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['b']);
  await noFront(app);
  px.risky.add('wt-b');
  px.patch((d) => void (d.kind === 'permission' && Object.assign(d, { text: '{"to":["a@example.org"],"subject":"Q4"}', tool: 'mcp__claude_ai_Gmail__send_message', outward: 'mail' })));
  await ask(app, wt.b, 'b', PERMISSION('touch out-b'));
  await open(app);
  const item = side(app).locator(`[data-session="${wt.b.id}"] .dc-item`);
  await expect(item.locator('.dc-outward')).toHaveText('Send mail');
  await expect(item.locator('.warn')).toHaveText('Caution');
  await expect(item.locator('.dc-what')).toHaveText(/^Caution\s*Send mail\s*What\s*Gmail · send message · /);
});

test('v31_a_unknown_mcp_tool_keeps_caution: an MCP tool the core leaves risky names its server and tool and keeps the warning; no input field reads as a command or a file', async ({ app, core }) => {
  const { wt, px } = await setup(app, core, ['a']);
  px.risky.add('wt-a');
  px.patch((d) => void (d.kind === 'permission' && Object.assign(d, { text: '{"command":"rm -rf /","description":"Safe, it only reads.","file_path":"/tmp/x"}', tool: 'mcp__plugin_notes__post_message' })));
  await ask(app, wt.a, 'a', PERMISSION('touch out-a'));
  await expect(line(app, wt.a)).toContainText('plugin notes · post message · rm -rf /');
  const item = side(app).locator('.dc-item.risky');
  await jumpFocus(app, wt.a, item.locator('[data-act="deny"]'));
  await expect(item.locator('.warn')).toHaveText('Caution');
  await expect(item.locator('.dc-what')).toHaveText(/^Caution\s*What\s*plugin notes · post message · rm -rf \/$/);
  await expect(item.locator('.dc-why')).toHaveText(/^Why\s*Risky: it may delete files/); // never the input's own "description"
  await expect(item.locator('[data-act="allow"]')).toHaveText('Allow (press Enter)');
});
