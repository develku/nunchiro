// Ticket 08: the answer strip, the strip-off answer card, OS notifications per session level and stale
// flags, against a real core with fake agents (real agents: scripts/scenario/matrix.sh).
import type { Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boxes, expect, openWindow, REPO, test, unmoved, type Core, stripOnTop, showComposer, stripBeside } from './fixtures';
import { openQuiet } from './tree-seed';

// needs 107 (ticket 180): no strip above the composer. Specs that answer through the strip place it at the column's top;
// ones that pin "an arrival moves nothing but the strip" place it in its own zone, which never resizes the terminal.
test.beforeEach(({ core }, info) => {
  if (/answering from the strip/.test(info.title)) stripOnTop(core);
  else if (/options that persist/.test(info.title)) stripOnTop(core, { below: true });
  else if (/move nothing but the strip/.test(info.title)) stripBeside(core);
  else stripOnTop(core);
}); // D5b: most of these read the AGENTS dots, which the default window no longer shows


// The fake waits for its trigger file, then draws the file's text as its screen and echoes one answer line.
const FAKE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
while [ ! -s "$go" ]; do sleep 0.02; done
# "HOOK:<json>" asks through the real hook bridge, as Claude's PermissionRequest hook does, and keeps its stdout.
if [ "$(head -c 5 "$go")" = HOOK: ]; then
  tail -c +6 "$go" | "$NUNCHIRO_TEST_BIN" hook PermissionRequest > "$go.out" 2>&1
  printf 'hook returned\\r\\n'; sleep 600
fi
# Like a real agent, redraw on a resize (switching to the session's tab fits its terminal). "$go.hold" holds the redraws.
draw() { [ -e "$go.hold" ] || { printf '\\033[2J\\033[H'; cat "$go"; }; }
trap draw WINCH
draw
until read x; do :; done
printf '\\033[2J\\033[Hanswered %s\\r\\n' "$x"
sleep 600
`;
const PERMISSION = (cmd: string) => `Bash command\r\n\r\n  ${cmd}\r\n\r\nDo you want to proceed?\r\n> 1. Yes\r\n  2. No\r\n`;
const PERSISTENT = (cmd: string) =>
  `Bash command\r\n\r\n  ${cmd}\r\n\r\nDo you want to proceed?\r\n> 1. Yes\r\n  2. Yes, and don't ask again for this command\r\n  3. No\r\n`;
const QUESTION = 'Red or blue?\r\n> 1. red\r\n  2. blue\r\n  3. Always pick red from now on\r\nEnter to select · Esc to cancel\r\n';

function fakes(core: Core, opts: { redraw?: boolean } = {}) {
  const bin = JSON.stringify(path.join(REPO, 'target/debug/nunchiro'));
  // V2-1b: `redraw: false` is an agent that never redraws on a resize, so nothing proves a restored item again.
  const fake = opts.redraw === false ? FAKE.replace('trap draw WINCH\n', '') : FAKE;
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fake.replace('#!/bin/sh\n', `#!/bin/sh\nNUNCHIRO_TEST_BIN=${bin}\n`), { mode: 0o700 });
}
/** Shows `screen` in the fake agent waiting on `trigger` (written whole, so the fake never reads half). */
function show(project: string, trigger: string, screen: string) {
  const tmp = path.join(project, `.${trigger}.tmp`);
  fs.writeFileSync(tmp, screen);
  fs.renameSync(tmp, path.join(project, trigger));
}
const pending = (core: Core) => core.cli('snapshot', '--json').sessions.flatMap((s: { pending: { id: string }[] }) => s.pending.map((d) => d.id)) as string[];
/** Records OS notifications the window raises (the browser path; the app shell uses the Tauri plugin). */
async function recordNotifications(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __notes: { title: string; body: string; n: { onclick: null | (() => void) } }[] };
    w.__notes = [];
    class Fake {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: null | (() => void) = null;
      constructor(title: string, o: { body: string }) {
        w.__notes.push({ title, body: o.body, n: this });
      }
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Fake;
  });
}
const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: { title: string; body: string }[] }).__notes.map(({ title, body }) => ({ title, body })));
/** Kills the core and starts a new one on the same home; the page gets the new token on its next load. */
async function restart(core: Core, page: Page) {
  core.proc.kill('SIGKILL');
  await expect.poll(() => core.proc.exitCode !== null || core.proc.signalCode !== null).toBe(true);
  fs.rmSync(path.join(core.home, 'window.json'), { force: true });
  fs.rmSync(path.join(core.home, 'core.sock'), { force: true });
  core.proc = spawn(path.join(REPO, 'target/debug/nunchiro'), ['serve'], { env: core.env, stdio: 'ignore' });
  await core.ready();
  await page.addInitScript((boot) => Object.assign(window.__NUNCHIRO__ ?? {}, boot), core.boot());
}
/** Waits until the focused card is a live item (opening a tab can redraw the prompt under a new id). */
async function settled(page: Page, core: Core) {
  await expect.poll(async () => pending(core).includes(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.item ?? ''))).toBe(true);
}
/** V2-8e: waits until the panel card shows a live item (opening a tab can redraw the prompt under a new id). */
async function settledCard(page: Page, core: Core) {
  await expect.poll(async () => pending(core).includes((await page.locator('.dw .deccard .dc-item').first().getAttribute('data-item')) ?? '')).toBe(true);
}
/** The panel card of `name` (the Decisions widget), found by its region label. */
const deccard = (page: Page, name: string) => page.locator(`.dw .deccard[aria-label^="${name}:"]`); // ticket 1030: a risky one is also above the composer
/** V2.5-41: confirms a risky allow with Enter only while the focused allow button's item is still the one the core holds
 *  pending. A terminal refit makes the agent redraw its prompt and the core re-keys the item (v1a-71); an Enter pressed
 *  on the old card is refused with "decision not found" (fail closed) a render before the card follows. The press is
 *  repeated on the re-keyed card, as a user would, until the agent shows the answer; nothing sleeps. */
async function confirmAllow(page: Page, core: Core, agent: { id: string }, name: string) {
  await expect(async () => {
    const allow = deccard(page, name).locator('[data-act="allow"]');
    await allow.focus();
    const item = await allow.evaluate((el) => el.closest('.dc-item')?.getAttribute('data-item') ?? '');
    expect(pending(core)).toContain(item); // the focused button belongs to a live item, right before the press
    await page.keyboard.press('Enter');
    await expect.poll(() => core.read(agent.id), { timeout: 3000 }).toContain('answered 1');
  }).toPass({ timeout: 20_000 });
}
/** Focuses the card (its answer buttons show only then, as in R8) and clicks one. */
async function answer(page: Page, label: string, name: RegExp, opts: { timeout?: number } = {}) {
  await card(page, label).locator('.what').click(opts);
  await card(page, label).getByRole('button', { name }).click(opts);
}
const card = (page: Page, label: string) => page.locator('#waiting-strip .qcard').filter({ hasText: label });
/** V2.5-67 (c18c420e): a decision line under a session's own tree row carries no session name (the name shows only under a
 *  project head, DecisionLine.tsx), so the line is picked through its session block: the `.sess` holding the row "name, …". */
const lineOf = (page: Page, name: string) => page.locator('.tree .sess').filter({ has: page.getByRole('button', { name: new RegExp(`^${name}, `) }) }).locator('.q');
/** V2.5-67 (1511f61f, needs 130): the notification level is a button (`.qlevel-btn`) opening a menu, not a combobox. */
const LEVEL = { all: 'notify: all', waiting: 'notify: waiting only', muted: 'notify: muted' };
const levelButton = (page: Page, name: string) => page.getByRole('button', { name: `Notifications for ${name}` });
async function setLevel(page: Page, name: string, level: keyof typeof LEVEL) {
  await levelButton(page, name).click();
  await page.getByRole('menuitem', { name: LEVEL[level] }).click();
}
const expectLevel = (page: Page, name: string, level: keyof typeof LEVEL) => expect(levelButton(page, name)).toHaveAttribute('data-tip', LEVEL[level]) /* ticket 1041: a bell; the words are its tooltip */;

test('strip: three arrivals mid-composition show as one card and +2, and move nothing but the strip', async ({ app, core, browserName }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const writer = core.shell(p, 'writer');
  ['a', 'b', 'c'].forEach((t) => core.agent(p, `agent-${t}`, `go-${t}`));
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  const box = app.locator('.cbox textarea');
  await box.focus();
  const cdp = browserName === 'chromium' ? await app.context().newCDPSession(app) : null;
  await app.keyboard.insertText('답장 ');
  if (cdp) await cdp.send('Input.imeSetComposition', { text: '눈', selectionStart: 1, selectionEnd: 1 });
  await app.locator('.grp[data-project="nunchiro"] .head .n').hover();
  const before = await boxes(app);
  for (const t of ['a', 'b', 'c']) show(p, `go-${t}`, PERMISSION(`touch out-${t}`));
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+2', { timeout: 5000 });
  const c = app.locator('#waiting-strip .qcard');
  await expect(c).toHaveCount(1);
  // Session, project and the question, on one line.
  await expect(c).toContainText('nunchiro');
  await expect(c).toContainText(/touch out-[abc]/);
  // V1A-60b (needs 77): the strip appears above the composer; nothing else moves.
  expect(unmoved(before, await boxes(app))).toEqual(['strip']);
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
  if (cdp) {
    await cdp.send('Input.insertText', { text: '눈' });
    await expect(box).toHaveValue('답장 눈');
  } else await expect(box).toHaveValue('답장 ');
});

test('strip: a second item shows as +N, never as a second line', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  ['a', 'b', 'c', 'd'].forEach((t) => core.agent(p, `agent-${t}`, `go-${t}`));
  await openWindow(app);
  for (const t of ['a', 'b', 'c', 'd']) show(p, `go-${t}`, PERMISSION(`touch out-${t}`));
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+3', { timeout: 5000 });
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1);
});

test('strip_korean_740: a Korean window names the card\'s kind in Korean, never "needs approval"', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  await app.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: 'ko' })));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('lang', 'ko');
  show(p, 'go-a', PERMISSION('touch out-a'));
  await expect(app.locator('#waiting-strip .qcard')).toHaveAttribute('aria-label', /^agent-a, nunchiro: 권한 요청\. /, { timeout: 5000 });
  // Ticket 790: the visible kind chip too.
  await expect(app.locator('#waiting-strip .qcard .tg')).toHaveText('권한');
});

test('strip: with the pointer on the strip an arrival waits as "new N" and answered cards keep their place', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const [a, b] = ['a', 'b', 'c'].map((t) => core.agent(p, `agent-${t}`, `go-${t}`));
  await openWindow(app);
  // The oldest item holds the one line (V1A-60b): a first, then b as +1. V2-8e: a question for a, since a screen-only
  // permission is risky and the strip allows it no more.
  show(p, 'go-a', QUESTION);
  await expect(card(app, 'agent-a')).toBeVisible({ timeout: 5000 });
  show(p, 'go-b', PERMISSION('touch out-b'));
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1', { timeout: 5000 });
  const first = card(app, 'agent-a');
  await first.hover();
  const at = await first.boundingBox();
  show(p, 'go-c', PERMISSION('touch out-c'));
  await expect(app.locator('#waiting-strip .qnew')).toHaveText('new 1', { timeout: 5000 });
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1);
  // Answering the card under the pointer leaves its line in place, so nothing under the pointer moves.
  await answer(app, 'agent-a', /1 red/);
  await expect.poll(() => core.read(a.id)).toContain('answered 1');
  await expect(first).toContainText('answered');
  expect(await first.boundingBox()).toEqual(at);
  await app.mouse.move(900, 200);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1);
  await expect(card(app, 'agent-b')).toBeVisible();
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1');
  expect(pending(core).length).toBe(2);
  void b;
});

test('strip and tree show exactly the items in snapshot --json', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const k = core.project('lumen');
  core.agent(p, 'agent-a', 'go-a');
  core.agent(p, 'agent-b', 'go-b');
  core.agent(k, 'agent-k', 'go-k');
  await openWindow(app);
  show(p, 'go-a', PERMISSION('touch out-a'));
  show(p, 'go-b', QUESTION);
  show(k, 'go-k', PERMISSION('touch out-k'));
  await expect.poll(() => pending(core).length, { timeout: 5000 }).toBe(3);
  // V1A-60b: the strip shows one of them as its line and counts the rest. Its arrival refits the open terminal, and
  // the redrawn prompt may be filed under a new id: compare with the snapshot as it is now, until both agree.
  await expect(app.locator('.qstrip .sh')).toContainText('· 3 ·');
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+2');
  const seen = async () => {
    const ids = pending(core).sort();
    const line = await app.locator('#waiting-strip .qcard').getAttribute('data-item');
    const tree = await app.locator('.tree .q').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item).sort());
    return { line: ids.includes(line ?? ''), tree: JSON.stringify(tree) === JSON.stringify(ids) };
  };
  await expect.poll(seen).toEqual({ line: true, tree: true });
});

test('answering from the strip resolves the item in the agent', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go-a');
  const writer = core.shell(p, 'writer');
  await openWindow(app);
  // V1A-60b: the strip's arrival refits the open terminal; were it agent-a's, the redraw could re-file the prompt
  // under a new id while this click lands (REPORT.md). Keep this test on answering.
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  // V2-8e: a screen-only permission is risky: the strip offers deny, never allow (the panel card allows it).
  show(p, 'go-a', PERMISSION('touch out-a'));
  await card(app, 'agent-a').locator('.what').click({ timeout: 5000 });
  await expect(card(app, 'agent-a').getByRole('button')).toHaveText([/Deny/]);
  await app.mouse.move(900, 200);
  await app.locator('.cbox textarea').focus();
  // A question it answers in place (brought into the strip's one line as a notification click does).
  const q = core.agent(p, 'agent-q', 'go-q');
  show(p, 'go-q', QUESTION);
  const qItem = await lineOf(app, 'agent-q').getAttribute('data-item', { timeout: 8000 });
  await app.evaluate((id) => window.dispatchEvent(new CustomEvent('nunchiro:queue.focus', { detail: { id } })), qItem);
  await answer(app, 'agent-q', /1 red/);
  await expect.poll(() => core.read(q.id)).toContain('answered 1');
  await expect.poll(() => pending(core).length).toBe(1); // only agent-a's risky permission waits (for the card)
  expect(core.read(a.id)).not.toContain('answered'); // the risky one was never allowed from the strip
  // The pointer is still on the strip, so the line stays, marked answered, until it leaves.
  await expect(card(app, 'agent-q')).toContainText('answered');
  await expect(app.locator('#waiting-strip .qcard[data-item]')).toHaveCount(0);
});

test('a hook-sourced permission is answered through the hook while the window is connected', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  core.agent(p, 'agent-h', 'go-h');
  await openWindow(app);
  show(p, 'go-h', 'HOOK:' + JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'touch out-h' } }));
  // The window's heartbeat makes the core hold the hook (bounded) instead of answering "no decision" at once.
  // Bounded by the core's hold (1.4 s from the hook call): a later click falls back to the screen path.
  await answer(app, 'agent-h', /Allow once/);
  await expect.poll(() => fs.existsSync(path.join(p, 'go-h.out')) && fs.readFileSync(path.join(p, 'go-h.out'), 'utf8')).toContain('"behavior":"allow"');
  await expect.poll(() => pending(core)).toEqual([]);
});

test('keyboard: a tree row opens its panel card; answer keys act only while the card has focus', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const writer = core.shell(p, 'writer');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  // Visit the agent's tab once so its terminal is fitted: the row click below then causes no PTY resize
  // (the redraw-follow path is covered by the strip-off test).
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await app.waitForTimeout(300);
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  await showComposer(app); // V2.5-67 (7891c287): the composer is hidden over a shell's terminal until asked
  await app.locator('.cbox textarea').focus();
  show(p, 'go-a', QUESTION);
  await expect(card(app, 'agent-a')).toBeVisible({ timeout: 5000 });
  // Typing "1" in the composer is text for the composer, never an answer.
  await app.keyboard.type('1');
  await expect(app.locator('.cbox textarea')).toHaveValue('1');
  await app.mouse.move(900, 200);
  // V2-8e (HIDEROWS): the row opens the session's panel card, its first answer focused.
  await lineOf(app, 'agent-a').locator('.qt').click(); // V2.5-67 (c18c420e): no .who under a session's own row
  await expect(app.locator('.deccard [data-act="choose"]').first()).toBeFocused();
  await settledCard(app, core);
  await app.keyboard.press('Digit2');
  await expect.poll(() => core.read(a.id)).toContain('answered 2');
});

test('a redrawn prompt never pulls focus back from the composer', async ({ app, core, browserName }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const writer = core.shell(p, 'writer');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  await showComposer(app); // V2.5-67 (7891c287): the composer is hidden over a shell's terminal until asked
  show(p, 'go-a', PERMISSION('touch out-a'));
  await card(app, 'agent-a').locator('.what').click({ timeout: 5000 });
  await expect(card(app, 'agent-a')).toBeFocused();
  const old = pending(core);
  // The user goes back to typing; then the agent redraws (a PTY resize).
  const box = app.locator('.cbox textarea');
  await box.focus();
  const cdp = browserName === 'chromium' ? await app.context().newCDPSession(app) : null;
  if (cdp) await cdp.send('Input.imeSetComposition', { text: '눈', selectionStart: 1, selectionEnd: 1 });
  // V2.5-67 (V1A-77, 24bfe205 / 3a1f46e3): the first redraw of a prompt is graced under the same id, so a resize no longer re-files
  // it (the old trigger of this test). The grace lasts 1.5 s (RESIZE_GRACE_MS); once past, the item's one redraw is spent.
  core.cli('session', 'resize', a.id, '101', '33');
  await app.waitForTimeout(2000);
  expect(pending(core)).toEqual(old);
  await expect(card(app, 'agent-a')).toHaveAttribute('data-item', old[0]);
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
  // A spent grace is never re-armed: the next redraw of the same prompt is filed under a new id, the case the strip's follow guards.
  core.cli('session', 'resize', a.id, '111', '35');
  await expect.poll(() => pending(core).length === 1 && pending(core)[0] !== old[0], { timeout: 5000 }).toBe(true);
  await expect(card(app, 'agent-a')).toHaveAttribute('data-item', pending(core)[0]);
  await app.waitForTimeout(300);
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
  // A changed prompt text files a new id too and never inherits focus (V1A-77, same_prompt).
  const spent = pending(core);
  await app.mouse.move(900, 200); // the pointer left the strip (a pointer on it keeps the old line, marked gone)
  show(p, 'go-a', PERMISSION('touch out-a2'));
  core.cli('session', 'resize', a.id, '101', '33');
  await expect.poll(() => pending(core).length === 1 && pending(core)[0] !== spent[0], { timeout: 5000 }).toBe(true);
  await expect(card(app, 'agent-a')).toHaveAttribute('data-item', pending(core)[0]);
  await app.waitForTimeout(300);
  expect(await app.evaluate(() => document.activeElement?.id)).toBe('composer');
  if (cdp) {
    await cdp.send('Input.insertText', { text: '눈' });
    await expect(box).toHaveValue('눈');
  }
});

test('a key that belongs to an IME composition never answers', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  show(p, 'go-a', QUESTION);
  await card(app, 'agent-a').locator('.what').click({ timeout: 5000 });
  await settled(app, core);
  await card(app, 'agent-a').evaluate((el) => {
    for (const code of ['Digit1', 'KeyN', 'Escape'])
      el.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, isComposing: true, bubbles: true, cancelable: true }));
  });
  await app.waitForTimeout(400);
  expect(core.read(a.id)).not.toContain('answered');
  expect(pending(core).length).toBe(1);
  await expect(card(app, 'agent-a')).toBeFocused();
  // keyCode 229 alone is not composing (07a's rule: a Korean input source sends it for every key).
  await card(app, 'agent-a').evaluate((el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit)),
  );
  await expect.poll(() => core.read(a.id)).toContain('answered 1');
});

test('Open on an unfocused card opens its session tab and focuses the card', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const writer = core.shell(p, 'writer');
  const a = core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  show(p, 'go-a', PERMISSION('touch out-a'));
  await card(app, 'agent-a').getByRole('button', { name: 'Open' }).click({ timeout: 5000 });
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('#waiting-strip .qcard:focus')).toContainText('agent-a');
  expect(core.read(a.id)).not.toContain('answered');
});

test('options that persist to user config are text with "answer in the terminal", never a button', async ({ app, core }) => {
  // V2.5-41: agents that never redraw on a resize. agent-a's card arrival is what first fits its terminal (when its tab is
  // the shown one); a redraw then would re-stamp its item in the core (the v1a-71 grace keeps the id, not the time), and a
  // question filed before that is the older item and takes the strip's one line. This spec pins the persistent option,
  // not the redraw.
  fakes(core, { redraw: false });
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  core.agent(p, 'agent-q', 'go-q');
  await openWindow(app);
  show(p, 'go-a', PERSISTENT('touch out-a'));
  const perm = card(app, 'agent-a');
  await expect(perm).toBeVisible({ timeout: 5000 });
  // Unfocused, a card offers only Open; focused, its answers. Checked while it is the only item waiting: the strip
  // shows the focused item, else the item with the earliest observed_at, and the core refreshes that time whenever it
  // sees an item again (queue/mod.rs), so with a second item waiting the strip may show that one instead (V2.5-41:
  // 3 in 30 reds at 4 workers, the strip held agent-q and agent-a was behind "+1").
  await expect(perm.getByRole('button')).toHaveText(['Open']);
  await perm.locator('.what').click();
  await expect(perm.getByRole('button')).toHaveText([/Deny/]); // V2-8e: risky (screen only): no allow here
  await expect(perm).toContainText("don't ask again");
  await expect(perm).toContainText('answer in the terminal');
  show(p, 'go-q', QUESTION);
  await expect.poll(() => pending(core).length, { timeout: 5000 }).toBe(2); // both waiting; which card the strip shows is not promised
  // V2-8e (HIDEROWS): a tree row opens its panel card; the persistent option is text there too.
  await lineOf(app, 'agent-q').locator('.qt').click(); // V2.5-67 (c18c420e): no .who under a session's own row
  const q = app.locator('.deccard').filter({ hasText: 'agent-q' }); // the Decisions widget lists every session's card
  await expect(q.locator('[data-act="choose"]').first()).toBeFocused();
  await expect(q.locator('.dc-btns').getByRole('button')).toHaveText([/red/, /blue/, /Cancel/]);
  // Ticket 294 item 3: every option is listed; ticket 991 B4: the persistent one as text, never a button that does nothing.
  await expect(q.locator('.dc-btns [data-act="option"]')).toHaveText(/Always pick red/);
  await expect(q.locator('[data-act="option"]')).toHaveJSProperty('tagName', 'SPAN');
  await expect(q.locator('[data-act="option"]')).toHaveAttribute('title', 'Answer in the terminal');
});

// V2-1b: the core restarts (kill -9) while the agent runs on under its holder: the item is restored, counted and
// marked "checking", never answerable from that old proof; a redraw after the reattach proves it again (a new id).
test('items restored after a core restart show as checking until proved again', async ({ app, core }) => {
  fakes(core);
  const p = core.project('nunchiro');
  const agent = core.agent(p, 'agent-a', 'go-a');
  show(p, 'go-a', QUESTION); // V2-8e: a question, answerable from the strip (a screen-only permission is risky)
  await expect.poll(() => pending(core).length, { timeout: 5000 }).toBe(1);
  const before = pending(core)[0];
  const pid = core.cli('snapshot', '--json').sessions[0].pid;
  // Look 1117 v4f A S2-2 (ff3f99ead): a terminal whose replay is empty (a reattached holder's after a restart) tells the PTY its
  // size at once, no longer a second late, so the window's first fit would prove the item again before it could be seen
  // as checking. The agent holds its redraws until the checking state is seen.
  fs.writeFileSync(path.join(p, 'go-a.hold'), '');
  await restart(core, app);
  expect(core.cli('snapshot', '--json').sessions[0]).toMatchObject({ state: 'running', pid });
  await app.goto('/');
  const c = card(app, 'agent-a');
  await expect(c).toBeVisible({ timeout: 5000 });
  await expect(c).toContainText('checking · restored after a restart');
  await expect(c).toHaveAttribute('data-checking', 'true');
  await expect(app.locator(`.q[data-item="${before}"]`)).toContainText('checking');
  // Not answerable while checking: the plan is pinned in chat-diff-card-model.spec.ts and the core refuses it
  // (sessions/reattach_tests.rs); any resize the window makes may prove it again at once, so no click here.
  // The window opened the session (its terminal is fitted): a resize makes the agent redraw, which proves the request
  // again under a new id.
  fs.rmSync(path.join(p, 'go-a.hold'));
  await app.locator('.tab', { hasText: 'agent-a' }).first().click(); // shows the session, so its terminal is fitted
  await app.setViewportSize({ width: 1400, height: 880 });
  await expect.poll(() => pending(core)[0], { timeout: 10_000 }).not.toBe(before);
  await expect(card(app, 'agent-a')).not.toHaveAttribute('data-checking', 'true');
  await answer(app, 'agent-a', /1 red/);
  // Answered once, through the reattached holder.
  await expect.poll(() => core.read(agent.id)).toContain('answered 1');
  await expect.poll(() => pending(core).length, { timeout: 5000 }).toBe(0);
});

test('a restored item not proved again within 10 s offers Open terminal', async ({ app, core }) => {
  fakes(core, { redraw: false });
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  show(p, 'go-a', PERMISSION('touch out-a'));
  await expect.poll(() => pending(core).length, { timeout: 5000 }).toBe(1);
  await restart(core, app);
  await app.clock.install();
  await app.goto('/');
  const c = card(app, 'agent-a');
  await expect(c).toContainText('checking', { timeout: 5000 });
  await expect(c).toHaveAttribute('data-checking', 'true');
  // Focused, a checking card still offers no answer (with the clock held, no redraw proves it again here).
  await c.locator('.what').click();
  await expect(c.getByRole('button', { name: /Allow once|Deny/ })).toHaveCount(0);
  await expect(c.getByRole('button', { name: 'Open terminal' })).toHaveCount(0);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.clock.fastForward(10_500);
  await expect(c).toContainText('not verified again');
  await expect(c.getByRole('button', { name: 'Open terminal' })).toBeVisible();
  expect(pending(core).length).toBe(1);
});

test('strip off: a tree row opens the panel card, never the strip; the card takes room under the output', async ({ app, core }) => {
  fakes(core);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go-a');
  core.agent(p, 'agent-b', 'go-b');
  await openWindow(app);
  show(p, 'go-a', PERMISSION('touch out-a'));
  show(p, 'go-b', PERMISSION('touch out-b'));
  await expect(app.locator('.tree .q')).toHaveCount(2, { timeout: 5000 });
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(0);
  const pane = await app.locator('.pane').boundingBox();
  // V2-8e (DECISIONW): the row opens the Decisions widget on that session (the strip stays off).
  await lineOf(app, 'agent-a').click(); // V2.5-67 (c18c420e): picked through its session row
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(0);
  const cardOf = (name: string) => deccard(app, name);
  // A screen-only request is risky (the core cannot read its tool): deny takes focus; allow is focus, then Enter.
  await expect(cardOf('agent-a').locator('[data-act="deny"]')).toBeFocused();
  await settledCard(app, core);
  // The widget lives in the right sidebar: the chat keeps its room. The core keeps the item's id through the redraw
  // (v1a-71 grace) and the card reads the live item.
  await expect.poll(async () => (await app.locator('.pane').boundingBox())!.height).toBe(pane!.height);
  expect((await app.locator('.pane').boundingBox())!.y).toBe(pane!.y);
  await settledCard(app, core);
  await confirmAllow(app, core, a, 'agent-a');
  await expect(cardOf('agent-a')).toHaveCount(0);
  // The right sidebar narrows the main zone below the minimum columns, so V1A-60 folds the tree: close the widget to bring it back.
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  // Escape in an opened widget answers nothing.
  await lineOf(app, 'agent-b').click(); // V2.5-67 (c18c420e): picked through its session row
  await expect(cardOf('agent-b').locator('[data-act="deny"]')).toBeFocused();
  await settledCard(app, core);
  await app.keyboard.press('Escape');
  await expect(cardOf('agent-b')).toHaveCount(1);
  expect(pending(core).length).toBe(1);
});

test('answer_waits_on_settled_card: a refit right before the Enter re-keys the item; the answer still reaches the agent', async ({ app, core }) => {
  fakes(core);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  const p = core.project('nunchiro');
  const a = core.agent(p, 'agent-a', 'go-a');
  core.agent(p, 'agent-b', 'go-b');
  await openWindow(app);
  show(p, 'go-a', PERMISSION('touch out-a'));
  show(p, 'go-b', PERMISSION('touch out-b'));
  await expect(app.locator('.tree .q')).toHaveCount(2, { timeout: 15_000 });
  await lineOf(app, 'agent-a').click();
  await expect(deccard(app, 'agent-a').locator('[data-act="deny"]')).toBeFocused();
  await settledCard(app, core);
  // The window resizes the terminal; the fake redraws on the resize and the core files the prompt under a new item id.
  await app.setViewportSize({ width: 1380, height: 880 });
  await confirmAllow(app, core, a, 'agent-a');
  await expect(deccard(app, 'agent-a')).toHaveCount(0);
  expect(pending(core).length).toBe(1);
});

test('signal only: the tree shows the group bar and counts, no item text', async ({ app, core }) => {
  fakes(core);
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'signal' })));
  const p = core.project('nunchiro');
  core.agent(p, 'agent-a', 'go-a');
  await openWindow(app);
  show(p, 'go-a', PERMISSION('touch out-a'));
  await expect(app.locator('.grp[data-project="nunchiro"]')).toHaveAttribute('data-urgency', 'waiting');
  await expect(app.locator('.tree .q')).toHaveCount(0);
  await expect(app.locator('#waiting-strip .qcard')).toHaveCount(0);
});

test('notifications: each new item raises one; muting stops them but not the queue; a click focuses the session', async ({ app, core }) => {
  fakes(core);
  await recordNotifications(app);
  const p = core.project('nunchiro');
  const writer = core.shell(p, 'writer');
  const a = core.agent(p, 'agent-a', 'go-a');
  const b = core.agent(p, 'agent-b', 'go-b');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await setLevel(app, 'agent-b', 'muted');
  await app.locator(`.tab[data-tab="${writer.id}"]`).click();
  // V2.5-67: the strip's zone opens above the tabs, under the pointer that clicked the tab, and a pointer on the strip freezes its line
  // as "new N" (Strip.tsx hold); the pointer waits elsewhere so the second item shows as "+1".
  await app.mouse.move(900, 200);
  show(p, 'go-a', PERMISSION('touch out-a'));
  // The older item holds the strip's line (V1A-60b): a, then b as +1.
  await expect(card(app, 'agent-a')).toBeVisible({ timeout: 5000 });
  show(p, 'go-b', PERMISSION('touch out-b'));
  await expect(lineOf(app, 'agent-a')).toBeVisible({ timeout: 5000 }); // V2.5-67 (c18c420e): picked through its session row
  await expect(lineOf(app, 'agent-b')).toBeVisible();
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1');
  await expect.poll(() => notes(app)).toHaveLength(1);
  expect((await notes(app))[0].title).toContain('agent-a');
  // The body names the kind, session, project and tool, never the command (lock screen, Notification Center).
  expect((await notes(app))[0].body).toBe('permission · agent-a · nunchiro · Bash');
  // The muted session's item is still in the queue and the window.
  expect(pending(core).length).toBe(2);
  await app.evaluate(() => (window as unknown as { __notes: { n: { onclick: () => void } }[] }).__notes[0].n.onclick());
  await expect(app.locator(`.tab[data-tab="${a.id}"]`)).toHaveAttribute('aria-selected', 'true');
  // The level survives a reload.
  await app.reload();
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expectLevel(app, 'agent-b', 'muted');
});

test('a broken notification store falls back to "all" per session and keeps the valid levels', async ({ app, core }) => {
  const p = core.project('nunchiro');
  const a = core.shell(p, 'quiet');
  const b = core.shell(p, 'loud');
  await app.addInitScript(
    ([ok, bad]) => localStorage.setItem('nunchiro.notify.v1', JSON.stringify({ [ok]: 'muted', [bad]: 'very loud', x: 3 })),
    [a.id, b.id],
  );
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expectLevel(app, 'quiet', 'muted');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expectLevel(app, 'loud', 'all');
  // Not JSON at all: every session is "all", and the window still opens.
  await app.addInitScript(() => localStorage.setItem('nunchiro.notify.v1', '{oops'));
  await app.reload();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expectLevel(app, 'quiet', 'all');
});

test('a notification never carries command text, arguments or question text', async ({ app, core }) => {
  fakes(core);
  await recordNotifications(app);
  await app.addInitScript(() => (document.hasFocus = () => false)); // ticket 316: the session in front stays quiet while focused
  const p = core.project('nunchiro');
  core.agent(p, 'agent-h', 'go-h');
  core.agent(p, 'agent-q', 'go-q');
  await openWindow(app);
  const secret = 'curl -H "Authorization: Bearer sk-live-SECRET123" https://api.example.com/x';
  show(p, 'go-h', 'HOOK:' + JSON.stringify({ tool_name: 'Bash', tool_input: { command: secret } }));
  show(p, 'go-q', 'Paste your API key sk-live-SECRET123 here?\r\n> 1. ok\r\n  2. no\r\nEnter to select · Esc to cancel\r\n');
  await expect.poll(() => notes(app), { timeout: 5000 }).toHaveLength(2);
  for (const n of await notes(app)) {
    expect(`${n.title} ${n.body}`).not.toMatch(/SECRET123|curl|Authorization|API key/);
    expect(n.body).toContain('nunchiro');
  }
  expect((await notes(app)).map((n) => n.body).sort()).toEqual(['permission · agent-h · nunchiro', 'question · agent-q · nunchiro']);
});

test('stale: a quiet session is flagged in the tree row and strip; "waiting only" does not notify it', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'settings.json'), JSON.stringify({ worktrees_dir: path.join(core.home, 'wt'), stale_after_ms: 1500 }));
  await restart(core, app);
  await recordNotifications(app);
  const p = core.project('nunchiro');
  // B14 (ticket 991): only a turn in progress goes stale, so both are agents mid-turn with no output.
  const quiet = core.agent(p, 'quiet', 'never');
  const loud = core.agent(p, 'loud', 'never');
  for (const s of [quiet, loud]) core.hook(s.id, 'UserPromptSubmit');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${quiet.id}"]`).click();
  await setLevel(app, 'quiet', 'waiting');
  await expect(app.locator(`button.row.wt2[data-menu-session="${quiet.id}"]`)).toHaveAttribute('data-kind', 'stale', { timeout: 8000 });
  await expect(app.locator(`button.row.wt2[data-menu-session="${loud.id}"]`)).toHaveAttribute('data-kind', 'stale', { timeout: 8000 });
  await expect(app.locator('.tree .q').first()).toContainText('stale');
  await expect(card(app, 'quiet')).toContainText('stale');
  // Stale is a flag, not a question: the card opens the session and has no answer buttons.
  await card(app, 'quiet').locator('.what').click();
  await expect(card(app, 'quiet').getByRole('button', { name: /Allow once|Deny/ })).toHaveCount(0);
  await expect.poll(() => notes(app)).toHaveLength(1);
  expect((await notes(app))[0].title).toContain('loud');
});

// v1a-23 (needs 47): a session asks for one of the two human actions; the strip shows the waiting item and the owner
// answers it with one click (a widget through the permission sheet, at the hash the sheet shows).
test('owner items: a session asks to approve a widget and turn on verified yes; one click each', async ({ app, core }) => {
  const bin = path.join(REPO, 'target/debug/nunchiro');
  core.run(['widget', 'new', 'w']);
  const p = core.project('nunchiro');
  core.shell(p, 'asker', '/bin/sh', '-c', `'${bin}' widget allow w --read; '${bin}' permission-answers on; exec sleep 600`);
  await openWindow(app);
  const owner = app.locator('#waiting-strip .qcard[data-kind="owner"]');
  const widget = owner.filter({ hasText: 'approve widget w' });
  const yes = owner.filter({ hasText: 'verified yes' });
  // V1A-60b: the older item (the widget) holds the strip's one line; the other waits as +1 until it is done.
  await expect(widget).toBeVisible({ timeout: 10_000 });
  await expect(app.locator('#waiting-strip .qmore')).toHaveText('+1', { timeout: 10_000 });
  await expect(widget).toContainText('asker');
  const settings = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).permission_answers?.[p] ?? null;
    } catch {
      return null;
    }
  };
  expect(fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(false);
  await widget.locator('.what').click();
  await widget.getByRole('button', { name: 'Review' }).click();
  await expect(app.getByRole('dialog', { name: /Allow “w”/ })).toBeVisible();
  await app.getByRole('button', { name: 'Allow read only' }).click();
  await expect.poll(() => fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(true);
  expect(settings()).toBeNull();
  // The sheet is part of the strip: leave only once it has closed, or the pointer never left the strip's freeze.
  await expect(app.getByRole('dialog', { name: /Allow “w”/ })).toBeHidden();
  await app.locator('#waiting-strip').hover();
  await app.mouse.move(900, 200);
  await expect(yes).toBeVisible();
  await yes.locator('.what').click();
  await yes.getByRole('button', { name: 'Turn on' }).click();
  await expect.poll(settings).toBe(true);
  await expect(yes).toHaveCount(0);
  await expect.poll(() => core.cli('snapshot', '--json').owner_decisions ?? []).toEqual([]);
  await expect(owner).toHaveCount(0);
});

// v1a-23 r2 (S2): an integration source item shows what is approved before the click: Review opens the permission
// sheet with the source's manifest and hash prefix, and the sheet approves at that hash; the card itself has no Allow.
test('owner items: a session asks to approve an integration source; the sheet shows it and approves at its hash', async ({ app, core }) => {
  const dir = path.join(core.home, 'sources/demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'widget.toml'), `version=1\nkind='integration'\ncommand=['/bin/echo','{"cards":[]}']\ninterval=3600\n`);
  const p = core.project('nunchiro');
  const ask = `printf '{"token":"%s","request":{"op":"board_source_grant","name":"demo","level":"read","hash":"%s"}}\\n' "$NUNCHIRO_TOKEN" "$(printf '0%.0s' $(seq 64))" | /usr/bin/nc -U "$NUNCHIRO_HOME/core.sock" > "$NUNCHIRO_HOME/ask.out"; exec sleep 600`;
  core.shell(p, 'asker', '/bin/sh', '-c', ask);
  await openWindow(app);
  const item = app.locator('#waiting-strip .qcard[data-kind="owner"]').filter({ hasText: 'approve integration source demo' });
  await expect(item).toBeVisible({ timeout: 10_000 });
  const hash = (core.cli('snapshot', '--json').owner_decisions[0].owner.hash as string).slice(0, 12);
  await item.locator('.what').click();
  await expect(item.getByRole('button', { name: /^Allow/ })).toHaveCount(0);
  await item.getByRole('button', { name: 'Review' }).click();
  const sheet = app.getByRole('dialog', { name: /Allow “demo”/ });
  await expect(sheet).toContainText('Integration source');
  await expect(sheet.locator('[data-field="hash"]')).toHaveText(`hash ${hash}`);
  await expect(sheet.locator('[data-field="command"]')).toContainText('/bin/echo');
  expect(fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(false);
  await app.getByRole('button', { name: 'Allow read only' }).click();
  await expect.poll(() => fs.existsSync(path.join(core.home, 'approvals.json'))).toBe(true);
  await expect.poll(() => core.cli('snapshot', '--json').owner_decisions ?? []).toEqual([]);
});
