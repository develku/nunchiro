// V1A-60b (needs 77): the answer strip takes 0 px while nothing waits and appears as one card line when an item arrives;
// the terminal shrinks by its height, keeps its bottom row, and refits at most once a frame. needs 107 (ticket 180): no
// bar above the composer (a strip placed there draws nothing), so these specs place it on top of the terminal
// (fixtures.ts stripOnTop): the expected place below is the top of the column; every other check is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core, stripOnTop } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';

test.beforeEach(({ core }) => stripOnTop(core));

/** Strip, terminal and composer boxes, the xterm rows drawn and the rows that fit the terminal's content box. */
const geo = (app: Page) =>
  app.evaluate(() => {
    const box = (s: string) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null;
    };
    const term = document.querySelector<HTMLElement>('.term:not([hidden])')!;
    const rows = [...term.querySelectorAll<HTMLElement>('.xterm-rows > div')];
    const cell = rows[0]?.getBoundingClientRect().height ?? 1;
    const cursor = term.querySelector('.xterm-cursor')?.closest('.xterm-rows > div')?.getBoundingClientRect();
    const last = rows.at(-1)?.getBoundingClientRect();
    return {
      strip: box('#waiting-strip')!,
      terminal: box('[data-zone-id="terminal"]')!,
      composer: box('[data-zone-id="composer"]')!,
      rows: rows.length,
      fits: Math.floor(parseFloat(getComputedStyle(term).height) / cell),
      cursorBottom: cursor ? Math.round(cursor.bottom) : null,
      lastBottom: last ? Math.round(last.bottom) : null,
    };
  });

/** Counts PTY resize requests and animation frames from now on. */
const countResizes = (app: Page) =>
  app.evaluate(() => {
    const w = window as unknown as { __resizes: number; __frames: number };
    w.__resizes = 0;
    w.__frames = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && data.includes('"op":"resize"')) w.__resizes++;
      return send.call(this, data);
    };
    const tick = () => (w.__frames++, requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
const counts = (app: Page) =>
  app.evaluate(() => {
    const w = window as unknown as { __resizes: number; __frames: number };
    return { resizes: w.__resizes, frames: w.__frames };
  });

/** An agent's terminal lives in the side pane (AGENTVIEW); these tests need it open (pane/store.ts store). */
const asTerminal = (app: Page, ids: string[]) =>
  app.addInitScript((ids) => localStorage.setItem('nunchiro.pane.open.v1', JSON.stringify(Object.fromEntries(ids.map((id) => [id, true])))), ids);
/** Focuses the terminal: xterm draws its cursor row only while focused, so the cursor check needs it. */
const focusTerm = (app: Page, a: { id: string }) => app.locator(`.term[data-session="${a.id}"] .xterm-helper-textarea`).focus();
/** Opens the session's tab and waits for its terminal. */
async function show(app: Page, a: { id: string }) {
  await app.locator(`button.row.wt2[data-menu-session="${a.id}"]`).click();
  await expect(app.locator(`.term[data-session="${a.id}"] .xterm-screen`)).toBeVisible();
}
// The fixtures' fake Claude, except that an answer clears the dialog off its screen, so the item goes (as in queue.spec.ts).
const FAKE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
while [ ! -f "$go" ]; do sleep 0.02; done
printf '\\033[2J\\033[HDo you want to proceed?\\r\\n1. Yes\\r\\n2. No\\r\\n'
read x
printf '\\033[2J\\033[Hanswered %s\\r\\n' "$x"
sleep 600
`;
const fake = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE, { mode: 0o700 });
/** Writes the trigger the fake agent waits for (one per agent: agents in one project share its folder). */
const arrive = (a: { cwd: string; go: string }) => fs.writeFileSync(path.join(a.cwd, a.go), '');
const answer = (core: Core, a: { id: string }) => core.run(['session', 'send-keys', a.id, '1', 'enter']) // lane w102: send-text waits out a start question;

test('answer-strip-empty-zero: with nothing waiting the strip takes 0 px and the terminal meets the composer', async ({ app, core }) => {
  const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
  await asTerminal(app, [a.id]);
  await openWindow(app);
  await show(app, a);
  const strip = app.locator('#waiting-strip');
  await expect(strip).toHaveCSS('height', '0px');
  await expect(strip).toHaveCSS('border-top-width', '0px');
  await expect(strip).not.toContainText('reserved');
  const g = await geo(app);
  expect(g.terminal.bottom).toBe(g.composer.top);
});

test('answer-strip-arrival: one card line on top of the terminal, +N for the rest; the terminal keeps its bottom row', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c] = ['a', 'b', 'c'].map((t) => ({ ...core.agent(p, `asks-${t}`, `go-${t}`), go: `go-${t}` }));
  await asTerminal(app, [a.id]);
  await openWindow(app);
  await show(app, a);
  await focusTerm(app, a);
  const before = await geo(app);
  arrive(a);
  const strip = app.locator('#waiting-strip');
  await expect(strip.locator('.qcard')).toHaveCount(1, { timeout: 15_000 });
  await expect(strip.locator('.qcard')).toContainText('asks-a');
  arrive(b);
  arrive(c);
  await expect(strip.locator('.qmore')).toHaveText('+2', { timeout: 15_000 });
  await expect(strip.locator('.qcard')).toHaveCount(1);
  await expect(strip.locator('.qcard')).toContainText('asks-a');
  await expect(strip.locator('.qcard')).toBeInViewport();
  // One line: the card and its +N share a row no taller than the approved 28 px.
  const g = await geo(app);
  expect(g.strip.height).toBeGreaterThan(0);
  expect(g.strip.height).toBeLessThanOrEqual(28);
  expect(g.composer).toEqual(before.composer);
  expect(g.strip.bottom).toBe(g.terminal.top);
  expect(g.terminal.bottom).toBe(g.composer.top);
  await expect.poll(async () => (await geo(app)).rows).toBe(g.fits);
  const after = await geo(app);
  expect(after.rows).toBeLessThan(before.rows);
  expect(after.lastBottom!).toBeLessThanOrEqual(after.terminal.bottom);
  expect(after.cursorBottom, 'the cursor row is drawn').not.toBeNull();
  expect(after.cursorBottom!).toBeLessThanOrEqual(after.terminal.bottom);
});

test('answer_strip_more_goes_next (ticket 199): clicking "+N" opens the next waiting item, then wraps to the oldest', async ({ app, core }) => {
  const p = core.project('demo');
  const agents = ['a', 'b', 'c'].map((t) => ({ ...core.agent(p, `asks-${t}`, `go-${t}`), go: `go-${t}` }));
  await asTerminal(app, [agents[0].id]);
  await openWindow(app);
  await show(app, agents[0]);
  const strip = app.locator('#waiting-strip');
  // One at a time, so the oldest-first order is a, b, c.
  for (const [i, a] of agents.entries()) {
    arrive(a);
    await expect(strip.locator('.sh [aria-live]')).toContainText(` · ${i + 1} · `, { timeout: 15_000 });
  }
  const card = strip.locator('.qcard[data-item]');
  await expect(card).toContainText('asks-a');
  const more = strip.getByRole('button', { name: /^\+2, Show the next waiting item$/ });
  for (const next of ['asks-b', 'asks-c', 'asks-a']) {
    await more.click();
    await expect(card).toContainText(next);
    await expect(card).toBeFocused();
    await expect(strip.locator('.qmore')).toHaveText('+2');
  }
});

test('answer-strip-departure: answering the last item gives the space back and the rows return', async ({ app, core }) => {
  fake(core);
  const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
  await asTerminal(app, [a.id]);
  await openWindow(app);
  await show(app, a);
  const start = (await geo(app)).rows;
  arrive(a);
  const strip = app.locator('#waiting-strip');
  await expect(strip.locator('.qcard[data-item]')).toHaveCount(1, { timeout: 15_000 });
  answer(core, a);
  await expect(strip.locator('.qcard')).toHaveCount(0, { timeout: 15_000 });
  await expect(strip).toHaveCSS('height', '0px');
  await expect.poll(async () => (await geo(app)).rows).toBe(start);
});

test('answer-strip-no-resize-storm: a burst of arrivals and answers refits at most once a frame', async ({ app, core }) => {
  const p = core.project('demo');
  fake(core);
  const agents = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => ({ ...core.agent(p, `asks-${t}`, `go-${t}`), go: `go-${t}` }));
  await asTerminal(app, agents.map((a) => a.id));
  await openWindow(app);
  await show(app, agents[0]);
  const start = (await geo(app)).rows;
  await countResizes(app);
  // Arrivals and answers land on different snapshots, so the strip's height changes in several frames in a row.
  agents.forEach(arrive);
  await expect(app.locator('#waiting-strip .qcard[data-item]')).toHaveCount(1, { timeout: 15_000 });
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+5', { timeout: 15_000 });
  agents.forEach((a) => answer(core, a));
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await geo(app)).rows).toBe(start);
  const n = await counts(app);
  expect(n.resizes).toBeGreaterThan(0);
  expect(n.resizes).toBeLessThanOrEqual(n.frames);
  // The strip appeared once and went once: two refits, not one per arrival or answer.
  expect(n.resizes).toBeLessThanOrEqual(2);
});

for (const mode of ['off', 'signal'] as const)
  test(`answer-strip-modes: "${mode}" stays 0 px and an arrival never changes the terminal's rows`, async ({ app, core }) => {
    await app.addInitScript((m) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: m })), mode);
    const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
    await asTerminal(app, [a.id]);
    await openWindow(app);
    await show(app, a);
    const before = await geo(app);
    arrive(a);
    await expect(app.locator(`button.row.wt2[data-menu-session="${a.id}"]`)).toHaveClass(/\byou\b/, { timeout: 15_000 });
    // The arrival alone changes nothing.
    const arrived = await geo(app);
    expect(arrived.rows).toBe(before.rows);
    expect(arrived.terminal).toEqual(before.terminal);
    expect(arrived.composer).toEqual(before.composer);
    // DECISIONW: a row click opens the Decisions widget in the right sidebar (the user's act), never a strip card,
    // and nothing in the chat area changes: the card no longer takes room from the output.
    if (mode === 'off') {
      await app.locator('.tree .q').first().click();
      await expect(app.locator('aside.sbar[data-side="right"] .deccard')).toHaveCount(1);
      await expect(app.locator('#waiting-strip .qcard')).toHaveCount(0);
    }
    const g = await geo(app);
    expect(g.rows).toBe(before.rows);
    expect(g.terminal.top).toBe(before.terminal.top);
    expect(g.terminal.height).toBe(before.terminal.height);
    expect(g.composer).toEqual(before.composer);
    if (mode === 'signal') await expect(app.locator('#waiting-strip')).toHaveCSS('height', '0px');
  });

// Outcome 3, chat half: the chat's scroller keeps its scrollTop when the strip shrinks it, so ChatView re-pins a
// following chat on the scroller's resize.
chatTest('answer-strip-chat-bottom: a chat scrolled to the bottom stays at the bottom when the strip appears', async ({ page, chatCore }) => {
  stripOnTop(chatCore); // ticket 180: on top of the chat, never above the composer
  const s = chatCore.chat();
  append(s.file, ...Array.from({ length: 80 }, (_, i) => (i % 2 ? rec.assistant(`answer ${i}`) : rec.user(`question ${i}`))));
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('answer 79')).toBeVisible();
  const gap = () => chat(page, s.id).locator('.cscroll').evaluate((e) => Math.round(e.scrollHeight - e.scrollTop - e.clientHeight));
  await expect.poll(gap).toBe(0);
  // A session asks the owner to turn on verified yes: one owner item, so the strip appears.
  const bin = path.join(REPO, 'target/debug/nunchiro');
  chatCore.shell(chatCore.project('asker'), 'asker', '/bin/sh', '-c', `'${bin}' permission-answers on; exec sleep 600`);
  await expect(page.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(gap).toBe(0);
});

test('answer-strip-oldest-again: when focus leaves an item brought into the line, the line shows the oldest again', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b] = ['a', 'b'].map((t) => ({ ...core.agent(p, `asks-${t}`, `go-${t}`), go: `go-${t}` }));
  await openWindow(app);
  const line = app.locator('#waiting-strip .qcard');
  arrive(a);
  await expect(line).toContainText('asks-a', { timeout: 15_000 });
  arrive(b);
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1', { timeout: 15_000 });
  // V2-8e: a tree row opens the panel card now; `queue.focus` (a notification click, waiting.next) brings b in.
  // needs 92 (TREEROWS, 02be66ec): the session name is on the row and the decision line under it carries the question
  // only, so the line is found through its row, not by the name.
  const b_item = await app.locator('.tree .sess').filter({ hasText: 'asks-b' }).locator('.q').getAttribute('data-item');
  await app.evaluate((id) => window.dispatchEvent(new CustomEvent('nunchiro:queue.focus', { detail: { id } })), b_item);
  await expect(line.filter({ hasText: 'asks-b' })).toBeFocused();
  await app.locator('#composer').click();
  await app.mouse.move(900, 200);
  await expect(line).toContainText('asks-a');
  await expect(line).toHaveCount(1);
});

test('answer-strip-zoned: with the terminal zone split beside a Context zone, the strip sits over both and the terminal keeps its rows in view', async ({ app, core }) => {
  const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
  await asTerminal(app, [a.id]);
  await openWindow(app);
  core.cli('layout', 'split', 'right', 'context', '--zone', 'terminal');
  await expect.poll(() => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-zone-id]')].map((e) => e.dataset.zoneId))).toEqual(['waiting', 'terminal', 'context', 'composer']);
  await show(app, a);
  await focusTerm(app, a);
  const beside = () => app.locator('[data-zone-id="context"]').evaluate((e) => Math.round(e.getBoundingClientRect().top));
  const before = await geo(app);
  arrive(a);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(async () => (await geo(app)).rows).toBeLessThan(before.rows);
  const g = await geo(app);
  expect(g.composer).toEqual(before.composer);
  expect(g.strip.bottom).toBe(g.terminal.top);
  expect(g.terminal.bottom).toBe(g.composer.top);
  expect(await beside()).toBe(g.strip.bottom);
  expect(g.rows).toBe(g.fits);
  expect(g.lastBottom!).toBeLessThanOrEqual(g.terminal.bottom);
  expect(g.cursorBottom, 'the cursor row is drawn').not.toBeNull();
  expect(g.cursorBottom!).toBeLessThanOrEqual(g.terminal.bottom);
});

// A fake Claude with 300 lines of history before its dialog, printed below them (no clear), so the reader can scroll up.
const LONG_FAKE = FAKE.replace("printf 'fake agent ready\\r\\n'", "i=1; while [ $i -le 300 ]; do printf 'history %s\\r\\n' $i; i=$((i+1)); done").replace("printf '\\033[2J\\033[HDo you want", "printf 'Do you want");

test('answer-strip-scrolled-up: a reader scrolled up in the history stays there while the strip appears, the row they read last still in view', async ({ app, core }) => {
  expect(LONG_FAKE).toContain('history %s');
  expect(LONG_FAKE).not.toContain('[HDo you want');
  fs.writeFileSync(path.join(core.home, 'bin/claude'), LONG_FAKE, { mode: 0o700 });
  const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
  await asTerminal(app, [a.id]);
  await openWindow(app);
  await show(app, a);
  const term = app.locator(`.term[data-session="${a.id}"]`);
  await expect(term.locator('.xterm-rows')).toContainText('history 300');
  const view = () => term.locator('.xterm-rows > div').evaluateAll((rows) => rows.map((r) => r.textContent!.trim()));
  // xterm's own scrollback key: a page up, the same in both engines (a wheel is not).
  await focusTerm(app, a);
  await app.keyboard.press('Shift+PageUp');
  await expect.poll(async () => (await view()).includes('history 300')).toBe(false);
  const before = await view();
  expect(before[0]).toMatch(/^history \d+$/);
  arrive(a);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(async () => (await geo(app)).rows).toBeLessThan(before.length);
  await app.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // The terminal shrinks keeping its bottom row: the same last row, the lines above it, never a jump to the dialog.
  const after = await view();
  expect(after.at(-1)).toBe(before.at(-1));
  expect(after).toEqual(before.slice(before.length - after.length));
});

test('answer-strip-own-zone: a strip placed in its own zone keeps the zone’s size, shows no empty text, and the terminal never resizes', async ({ app, core }) => {
  const a = { ...core.agent(core.project('demo'), 'asks', 'go'), go: 'go' };
  await asTerminal(app, [a.id]);
  await openWindow(app);
  core.cli('layout', 'move', 'waiting', 'split', 'right', '--zone', 'terminal');
  await expect.poll(() => app.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-zone-id]')].map((e) => e.dataset.zoneId))).toEqual(['terminal', 'waiting', 'composer']);
  await show(app, a);
  const zone = () => app.locator('[data-zone-id="waiting"]').evaluate((e) => [e.getBoundingClientRect()].map((r) => [r.x, r.y, r.width, r.height].map(Math.round).join(','))[0]);
  const before = { zone: await zone(), geo: await geo(app) };
  await expect(app.locator('[data-zone-id="waiting"]')).not.toContainText('reserved');
  expect(before.geo.terminal.bottom).toBe(before.geo.composer.top);
  arrive(a);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1, { timeout: 15_000 });
  await app.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await zone()).toBe(before.zone);
  const g = await geo(app);
  expect(g.terminal).toEqual(before.geo.terminal);
  expect(g.rows).toBe(before.geo.rows);
});
