// needs 169 (owner 2026-11-01): a sub-agent `↳` row opens. A transcript child opens its own output (read only) in a panel
// beside the parent's chat; a worker session opens as its own session; a child with no file of its own opens the
// parent's tab at the launch call. A real core and fake Claude whose transcript and `subagents/` files the test writes.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, ChatCore, expect, rec, test } from './fixtures/chat/harness';
import { Core, nunchiro, test as plain } from './fixtures';
import { agentsToml, fakeAcp, ownerOk, tomlEntry } from './acp-fakes';
import { openQuiet } from './tree-seed';

type Chat = ReturnType<ChatCore['chat']>;
const launch = (id: string, label: string) => ({ ...rec.use(id, 'Task', { description: label, prompt: 'look' }), timestamp: new Date(Date.now() - 90_000).toISOString() });
const side = (agentId: string, r: Record<string, unknown>) => ({ ...r, isSidechain: true, agentId });
/** `<session-id>/subagents/` beside the parent transcript, where Claude Code 2.1.312 writes children. */
const dir = (a: Chat) => path.join(path.dirname(a.file), a.agent_session_id, 'subagents');
/** Writes the child's meta file (its launch id) and its own transcript; `more` appends later. */
function child(a: Chat, agent: string, kid: string, text: string, extra: Record<string, unknown>[] = []) {
  fs.mkdirSync(dir(a), { recursive: true });
  fs.writeFileSync(path.join(dir(a), `agent-${agent}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'child', toolUseId: kid, spawnDepth: 1, finished: true }));
  fs.writeFileSync(path.join(dir(a), `agent-${agent}.jsonl`), '');
  more(a, agent, side(agent, rec.user('Find the ssh callers.')), side(agent, rec.use(`${kid}-g`, 'Grep', { pattern: 'ssh -G' })), side(agent, rec.result(`${kid}-g`, '3 matches')), side(agent, rec.assistant(text)), ...extra);
}
const more = (a: Chat, agent: string, ...records: unknown[]) => append(path.join(dir(a), `agent-${agent}.jsonl`), ...records);

const row = (app: Page, kid: string) => app.locator(`.row.kid[data-kid="${kid}"]`);
const count = (app: Page, id: string) => app.locator(`.kidcount[data-kids~="${id}"]`);
const peek = (app: Page) => app.locator('[data-kidpeek]');
const ready = (app: Page) => expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
const activeTab = (app: Page) => app.locator('.tab[aria-selected="true"]').getAttribute('data-tab');

/** One session `alpha` with two launches: t1 has its own file (a finished child), t2 has none. */
async function seed(app: Page, core: ChatCore) {
  const a = core.chat('alpha');
  openQuiet(core);
  append(a.file, rec.user('start'), launch('t1', 'Explore: find ssh callers'), launch('t2', 'Plan: page layout'));
  child(a, 'aX1', 't1', 'Found three callers.');
  await app.goto('/');
  await ready(app);
  return a;
}
async function openFold(app: Page, a: Chat) {
  await count(app, a.id).click();
  await expect(app.locator(`.kids[data-session="${a.id}"] .row.kid`)).toHaveCount(2);
}

test('kid_row_is_a_labelled_button: role, name, Tab, Enter, Space and click; the old hooks stay', async ({ app, chatCore: core, browserName }) => {
  const a = await seed(app, core);
  await openFold(app, a);
  const r = row(app, 't1');
  await expect(r).toHaveAttribute('role', 'button');
  await expect(app.getByRole('button', { name: 'Open sub-agent: Explore: find ssh callers' })).toHaveCount(1);
  await expect(r).toHaveAttribute('title', 'Open sub-agent: Explore: find ssh callers');
  for (const [attr, v] of [['data-kid', 't1'], ['data-state', 'running'], ['data-label', 'Explore: find ssh callers']] as const) await expect(r).toHaveAttribute(attr, v);
  // V2.5-61 (ticket 194): reachable by keys from the row that owns the fold's control; one tree row is in the Tab order
  // (roving tabindex), so the arrows reach it, and the focused row is the one with tabindex 0 (WebKit needs a key press
  // then focus, as tree-rows.spec does).
  await count(app, a.id).evaluate((e) => e.closest('.wtwrap, .row.head')?.querySelector<HTMLElement>('button.row.wt2, :scope > button.n')?.focus());
  if (browserName === 'webkit') (await app.keyboard.press('Shift'), await r.focus());
  for (let i = 0; i < 12 && !(await r.evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press('ArrowDown');
  await expect(r).toBeFocused();
  await expect(r).toHaveAttribute('tabindex', '0');
  for (const how of ['Enter', 'Space', 'click'] as const) {
    if (how === 'click') await r.click();
    else await app.keyboard.press(how === 'Space' ? ' ' : how);
    await expect(peek(app)).toHaveAttribute('data-kidpeek', 't1');
    await app.keyboard.press('Escape');
    await expect(peek(app)).toHaveCount(0);
    await expect(r).toBeFocused();
  }
});

test('claude_kid_opens_output_beside_parent: the child\'s own text in a panel at the right; the parent chat stays visible and usable; no textbox, answer or send control', async ({ app, chatCore: core }) => {
  const a = await seed(app, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"] .clist`)).toHaveAttribute('aria-busy', 'false');
  await openFold(app, a);
  await row(app, 't1').click();
  const p = peek(app);
  await expect(p).toBeVisible();
  await expect(p).toHaveAttribute('role', 'complementary');
  await expect(p).toContainText('Found three callers.');
  await expect(p).toContainText('Read-only: this is the sub-agent\'s own transcript');
  const [box, vw] = [(await p.boundingBox())!, app.viewportSize()!.width];
  expect(box.x).toBeGreaterThanOrEqual(vw * 0.55);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 1);
  // The parent's chat is still there at the left, under the point 25 percent across, and its composer takes focus.
  expect(await app.evaluate((x) => !!document.elementFromPoint(x, 450)?.closest(`.chat`), vw * 0.25)).toBe(true);
  await app.locator('.cbox textarea').focus();
  await expect(app.locator('.cbox textarea')).toBeFocused();
  // Read only: no textbox, no answer or allow control, no send.
  await expect(p.locator('textarea, input, [contenteditable], [role="textbox"], [data-act]')).toHaveCount(0);
  const names = await p.getByRole('button').allInnerTexts();
  for (const n of names) expect(n).not.toMatch(/allow|deny|accept|reject|send|answer|approve/i);
  await expect(p.getByRole('button', { name: 'Close sub-agent output' })).toBeVisible();
  // Its state word is the row's.
  expect(await p.locator('.kp-state').innerText()).toBe(await row(app, 't1').locator('.s').innerText());
});

/** Every request the window sends, in order (the browser's own frames; nothing is proxied or changed). */
function watch(page: Page) {
  const sent: { op: string; [key: string]: unknown }[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string') {
        const request = JSON.parse(f.payload).request;
        if (request) sent.push(request);
      }
    }),
  );
  return sent;
}

test('kid_panel_sends_and_writes_nothing: open, scroll, expand a tool row, refresh and close write nothing to the agent or the transcripts and ask only `subagents`', async ({ app, chatCore: core }) => {
  const sent = watch(app);
  await app.clock.install();
  const a = await seed(app, core);
  const files = [a.file, path.join(dir(a), 'agent-aX1.jsonl'), path.join(dir(a), 'agent-aX1.meta.json')];
  const before = files.map((f) => fs.readFileSync(f));
  const screen = core.screen(a.id);
  await openFold(app, a);
  const from = sent.length;
  await row(app, 't1').click();
  await expect(peek(app)).toContainText('Found three callers.');
  // Scroll, expand a tool row (the compact view folds the turn: open its summary), as a reader would.
  await peek(app).locator('.kp-body').evaluate((e) => (e.scrollTop = 0));
  for (const s of await peek(app).locator('button[aria-expanded="false"]').all()) await s.click();
  // The 5 s refresh is the page's own timer, advanced by the clock, not a sleep: a line the child wrote since shows up.
  more(a, 'aX1', side('aX1', rec.assistant('One more thing.')));
  await app.clock.runFor(5200);
  await expect(peek(app)).toContainText('One more thing.');
  await peek(app).getByRole('button', { name: 'Close sub-agent output' }).click();
  await expect(peek(app)).toHaveCount(0);
  // Only `subagents` reads went out since the click, besides the window's own 1 s presence beat (`queue_connect`) and the Board rail's count poll (`board_snapshot`). The Room's `room_read` comes on a push or its 15 s fallback poll (ticket 592), so none in this window.
  expect(new Set(sent.slice(from).map((r) => r.op))).toEqual(new Set(['subagents', 'queue_connect', 'board_snapshot']));
  expect(sent.slice(from).filter((r) => r.open === 't1').length).toBeGreaterThanOrEqual(2);
  files.forEach((f, i) => expect(fs.readFileSync(f).equals(before[i]) || f.endsWith('aX1.jsonl')).toBe(true));
  expect(fs.readFileSync(a.file).equals(before[0])).toBe(true);
  expect(core.screen(a.id)).toBe(screen);
  expect(core.screen(a.id)).not.toMatch(/answered/);
});

test('kid_panel_close_and_focus: Esc and the close button return focus to the row; a second child replaces the first; the parent ending closes it', async ({ app, chatCore: core }) => {
  const a = await seed(app, core);
  child(a, 'aX2', 't2', 'Page layout planned.');
  await openFold(app, a);
  await row(app, 't1').click();
  await expect(peek(app)).toContainText('Found three callers.');
  await app.keyboard.press('Escape');
  await expect(peek(app)).toHaveCount(0);
  await expect(row(app, 't1')).toBeFocused();
  await row(app, 't1').click();
  await peek(app).getByRole('button', { name: 'Close sub-agent output' }).click();
  await expect(peek(app)).toHaveCount(0);
  await expect(row(app, 't1')).toBeFocused();
  // One panel at a time: opening the other child replaces the first.
  await row(app, 't1').click();
  await expect(peek(app)).toHaveAttribute('data-kidpeek', 't1');
  await row(app, 't2').click();
  await expect(peek(app)).toHaveCount(1);
  await expect(peek(app)).toHaveAttribute('data-kidpeek', 't2');
  await expect(peek(app)).toContainText('Page layout planned.');
  // The parent session ending closes it.
  core.cli('session', 'close', a.id);
  await expect(peek(app)).toHaveCount(0);
});

test('kid_open_two_clicks: `↳ N` then the row opens the output, by pointer and by keyboard; the control is labelled', async ({ app, chatCore: core }) => {
  const a = await seed(app, core);
  await expect(app.locator(`.kids[data-session="${a.id}"] .row.kid`)).toHaveCount(0); // collapsed
  const control = app.getByRole('button', { name: /Show alpha's 2 sub-agents/ });
  await control.click(); // click 1
  await row(app, 't1').click(); // click 2
  await expect(peek(app)).toContainText('Found three callers.');
  await app.keyboard.press('Escape');
  await app.getByRole('button', { name: /Hide alpha's 2 sub-agents/ }).click(); // fold
  await expect(row(app, 't1')).toHaveCount(0);
  await control.focus();
  await app.keyboard.press('Enter');
  await row(app, 't1').focus();
  await app.keyboard.press('Enter');
  await expect(peek(app)).toContainText('Found three callers.');
});

test('parent_fallback_scrolls_to_task_call: a Claude child with no file opens the parent tab at the launch row; a call older than the loaded pages says so', async ({ app, chatCore: core }) => {
  const a = core.chat('alpha');
  openQuiet(core);
  // The launch sits far above the newest rows, so only a jump brings it into view.
  append(a.file, rec.user('start'), launch('t2', 'Plan: page layout'));
  for (let i = 0; i < 120; i++) append(a.file, rec.assistant(`filler ${i} `.repeat(30)));
  await app.goto('/');
  await ready(app);
  await count(app, a.id).click();
  await row(app, 't2').click();
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(peek(app)).toHaveCount(0);
  const hit = app.locator(`.chat[data-session="${a.id}"] [data-hit]`);
  await expect(hit).toBeInViewport();
  await expect(hit).toContainText('task'); // the launch row of the Task call (the compact view's "1 task")
});

test('parent_fallback_older_call_says_so: the core had no cursor for the call; the tab opens and the tree status line says why', async ({ app, chatCore: core }) => {
  const a = core.chat('alpha');
  openQuiet(core);
  append(a.file, rec.user('start'), launch('t2', 'Plan: page layout'));
  // The core's reply is the only thing changed: its `cursor` is dropped, as for a call older than the 20 newest pages.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"opened"')) return ws.send(m);
      const reply = JSON.parse(m);
      delete reply.response.Ok.opened.cursor;
      ws.send(JSON.stringify(reply));
    });
  });
  await app.goto('/');
  await ready(app);
  await count(app, a.id).click();
  await row(app, 't2').click();
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('[data-kid-note]')).toContainText('launched earlier than the chat shows');
  await expect(peek(app)).toHaveCount(0);
});

plain('parent_fallback_acp_child: an ACP child has no file; its row opens the parent tab and says the call is older', async ({ app, core }) => {
  const name = 'subs';
  fs.writeFileSync(agentsToml(core), tomlEntry(name, fakeAcp(core, name, 'subs 1.0')));
  ownerOk(core, { op: 'acp_agent_grant', name, hash: ownerOk(core, { op: 'acp_agent_status', name }).view.hash });
  const s = ownerOk(core, { op: 'start', session: { kind: 'acp', project: core.project(name), args: [name], model: null, effort: null, resume: null } }).session as { id: string };
  await expect.poll(() => ownerOk(core, { op: 'snapshot' }).sessions.find((x: { id: string }) => x.id === s.id)?.model).toBeTruthy();
  ownerOk(core, { op: 'agent_prompt', id: s.id, text: 'subagents' });
  openQuiet(core);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await count(app, s.id).click();
  await expect(app.locator(`.kids[data-session="${s.id}"] .row.kid`)).toHaveCount(2);
  await app.locator(`.row.kid[data-label="Test investigator"]`).click();
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('[data-kid-note]')).toBeVisible();
  await expect(peek(app)).toHaveCount(0);
});

/** A shell session that prints its token, started by `token`'s session (or the owner). */
async function worker(core: Core, project: string, label: string, token?: string) {
  const env = token ? { ...core.env, NUNCHIRO_TOKEN: token } : core.env;
  const args = ['session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN:%s\\n" "$NUNCHIRO_TOKEN"; exec cat'];
  const id = (JSON.parse(nunchiro(env, args)).session as { id: string }).id;
  let own = '';
  await expect.poll(() => (own = /TOKEN:(\S+)/.exec(core.read(id))?.[1] ?? '')).not.toBe('');
  return { id, token: own };
}

plain('worker_child_opens_as_own_session: a row built from a parent link opens that session\'s tab and draws no panel; nested rows open by their own kind', async ({ app, core }) => {
  openQuiet(core);
  const coordinator = await worker(core, core.project('orch'), 'coordinator');
  const w = await worker(core, core.project('w1'), 'worker', coordinator.token);
  const sub = await worker(core, core.project('w2'), 'sub-worker', w.token);
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await count(app, coordinator.id).click();
  await expect(app.locator(`.kids[data-session="${coordinator.id}"] .row.kid`)).toHaveCount(2);
  await row(app, w.id).click();
  await expect.poll(() => activeTab(app)).toBe(w.id);
  await expect(peek(app)).toHaveCount(0);
  await row(app, sub.id).focus();
  await app.keyboard.press('Enter');
  await expect.poll(() => activeTab(app)).toBe(sub.id);
  await expect(peek(app)).toHaveCount(0);
  await expect(row(app, sub.id)).toHaveAttribute('data-depth', '1'); // nesting still renders
});

test('kid_panel_screenshot_page: light and dark shots of the folded row, the open row, the panel with output and the fallback status line', async ({ app, chatCore: core }) => {
  const out = path.resolve(import.meta.dirname, '../../.scratch/subagents-open');
  fs.mkdirSync(out, { recursive: true });
  // Drop the core's cursor from every `opened` reply, as for a call older than the loaded pages: the real fallback line shows.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('"opened"')) return ws.send(m);
      const reply = JSON.parse(m);
      delete reply.response.Ok.opened.cursor;
      ws.send(JSON.stringify(reply));
    });
  });
  const a = await seed(app, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"] .clist`)).toHaveAttribute('aria-busy', 'false');
  const shots: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const shot = async (name: string) => (shots.push(`${name}-${scheme}.png`), void (await app.screenshot({ path: path.join(out, `${name}-${scheme}.png`) })));
    if (await app.locator('.row.kid').count()) await count(app, a.id).click(); // fold
    await expect(app.locator('.row.kid')).toHaveCount(0);
    await shot('1-folded-row');
    await count(app, a.id).click();
    await expect(app.locator('.row.kid')).toHaveCount(2);
    await shot('2-open-row');
    await row(app, 't1').click();
    await expect(peek(app)).toContainText('Found three callers.');
    await shot('3-panel-with-output');
    await app.keyboard.press('Escape');
    await expect(peek(app)).toHaveCount(0);
    // The fallback: a child with no file of its own (t2) opens the parent's tab and the tree's status line says why.
    await row(app, 't2').click();
    await expect(app.locator('[data-kid-note]')).toBeVisible();
    await shot('4-fallback-status-line');
    await app.locator('[data-kid-note]').getByRole('button', { name: 'Dismiss' }).click();
  }
  fs.writeFileSync(path.join(out, 'README.txt'), `No owner-approved frame exists for this panel (needs 169 accepted the behaviour only).\n${shots.join('\n')}\n`);
  expect(fs.readdirSync(out).filter((f) => f.endsWith('.png'))).toHaveLength(8);
});
