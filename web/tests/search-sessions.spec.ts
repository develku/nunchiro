// V2-7: Search's Sessions scope (draft 06 A with scope chips). The real core and fake Claude and Codex sessions whose
// transcripts the test writes; every `sessions_search` frame passes a recording proxy.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { REPO } from './fixtures';
import { append, ChatCore, chat, expect, rec, test } from './fixtures/chat/harness';

const BIN = path.join(REPO, 'target/debug/nunchiro');

// A fake Codex: it names its rollout to the core through its own hook token, as the real agent's SessionStart does.
const fakeCodex = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then echo 'codex-cli 0.161.0'; exit; fi
printf 'fake codex\\r\\n'
n=0
until '${BIN}' hook SessionStart < "${home}/codex-next.json" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100 ] && break; sleep 0.05; done
while IFS= read -r line; do [ "$line" = EXIT ] && exit 0; done
`;
let thread = 0;
function codexSession(core: ChatCore, label: string) {
  const id = `11111111-0000-4000-8000-${String(++thread).padStart(12, '0')}`;
  const dir = path.join(core.home, 'codex-home/sessions/2026/10/27');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-27T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, '');
  fs.writeFileSync(path.join(core.home, 'codex-next.json'), JSON.stringify({ thread_id: id, transcript_path: file }));
  fs.writeFileSync(path.join(core.home, 'bin/codex'), fakeCodex(core.home), { mode: 0o700 });
  const s = core.cli('session', 'start', '--kind', 'codex', '--project', core.project(label), '--label', label).session as { id: string; cwd: string };
  // A real rollout starts with its session_meta, which the core's locate checks.
  append(file, { type: 'session_meta', payload: { id, cwd: s.cwd } });
  return { ...s, file, thread: id };
}
const codexRec = (role: string, text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const snap = (core: ChatCore) => core.cli('snapshot', '--json').sessions as { id: string; agent_session_id: string | null; state: string }[];

// `hold.on` keeps every reply to a `sessions_search` frame until `hold.release()`.
async function record(page: Page) {
  const asked: { query: string; sessions: string[] }[] = [];
  const hold = { on: false, ids: new Set<number>(), kept: [] as (() => void)[], release: () => {} };
  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const f = JSON.parse(m);
        if (f.request?.op === 'sessions_search') {
          asked.push({ query: f.request.query, sessions: f.request.sessions });
          if (hold.on) hold.ids.add(f.id);
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (hold.on && typeof m === 'string' && hold.ids.has(JSON.parse(m).id)) hold.kept.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  hold.release = () => {
    hold.on = false;
    hold.kept.splice(0).forEach((send) => send());
  };
  // Not enumerable, so `expect(asked).toEqual([])` still reads a plain list.
  return Object.defineProperty(asked, 'hold', { value: hold }) as typeof asked & { hold: typeof hold };
}

const panel = (page: Page) => page.locator('.sbar .spanel');
const field = (page: Page) => panel(page).getByRole('searchbox');
const stat = (page: Page) => panel(page).locator('.sscope:not([hidden]) .sstat');
const group = (page: Page, id: string) => panel(page).locator(`.sgrp[data-session="${id}"]`);

async function openSessions(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await panel(page).getByRole('radio', { name: 'Sessions' }).click();
  await expect(field(page)).toHaveAccessibleName('Search sessions');
}
async function find(page: Page, q: string) {
  await field(page).fill(q);
  await field(page).press('Enter');
}

test('search_hit_opens_chat_at_event: Claude and Codex hits open their chat at the event, deep history included', async ({ page, chatCore: core }) => {
  const claude = core.chat('alpha');
  // 450 events: the hit (event 5) is two pages back from the newest page the chat opens on.
  append(claude.file, ...Array.from({ length: 450 }, (_, i) => (i === 4 ? rec.assistant('We retire the process group before reap.') : rec.user(`filler ${i}`))));
  const codex = codexSession(core, 'beta');
  await expect.poll(() => snap(core).find((s) => s.id === codex.id)?.agent_session_id).toBe(codex.thread);
  append(codex.file, codexRec('user', 'hello'), codexRec('assistant', 'Then retire the process group, said codex.'));
  await openSessions(page);
  await find(page, 'retire the process group');
  await expect(group(page, claude.id)).toBeVisible();
  await expect(group(page, codex.id)).toBeVisible();
  await expect(stat(page)).toHaveText('2 matches in 2 sessions');
  const hit = group(page, claude.id).getByRole('option');
  await expect(hit).toHaveCount(1);
  // The match is marked as text, case kept.
  await expect(hit.locator('mark')).toHaveText('retire the process group');
  await hit.click();
  await expect(page.locator(`.tab[data-tab="${claude.id}"]`)).toHaveAttribute('aria-selected', 'true');
  const target = chat(page, claude.id).locator('.crow[data-hit]');
  await expect(target).toContainText('We retire the process group before reap.');
  await expect(target).toBeInViewport();
  // Codex too, by keyboard: arrows walk the hits (newest session first), Enter opens.
  await field(page).press('ArrowDown');
  await page.keyboard.press('Home');
  const first = await panel(page).locator('.hit[data-index="0"]').evaluate((el) => el.closest('.sgrp')!.getAttribute('data-session'));
  if (first !== codex.id) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.tab[data-tab="${codex.id}"]`)).toHaveAttribute('aria-selected', 'true');
  const codexTarget = chat(page, codex.id).locator('.crow[data-hit]');
  await expect(codexTarget).toContainText('Then retire the process group, said codex.');
  await expect(codexTarget).toBeInViewport();
  await page.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-7-hit-${test.info().project.name}.png`) });
});

test('search_closed_session_opens_read_only_with_resume: a hit in a closed session opens read-only with Resume', async ({ page, chatCore: core }) => {
  const s = core.chat('gamma');
  append(s.file, rec.user('first'), rec.assistant('scrollback ring: retire the oldest chunk'));
  core.cli('session', 'close', s.id);
  await expect.poll(() => snap(core).find((r) => r.id === s.id)?.state).toBe('closed');
  await openSessions(page);
  await find(page, 'oldest chunk');
  await expect(group(page, s.id)).toContainText('closed');
  await group(page, s.id).getByRole('option').click();
  await expect(chat(page, s.id)).toHaveAttribute('data-readonly', '');
  await expect(chat(page, s.id).locator('.crow[data-hit]')).toContainText('retire the oldest chunk');
  await expect(page.getByRole('button', { name: /^Resume / })).toHaveCount(0); // needs 207: no resume row over the chat
  // v25-shell-chrome (ticket 282 item 2): no Resume strip; the tab's menu offers Restart session.
  await page.locator(`.tab[data-tab="${s.id}"]`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Resume session' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-7-closed-${test.info().project.name}.png`) });
});

test('search_hit_opens_chat_at_event: scope chips and the project, agent, date and closed filters narrow results', async ({ page, chatCore: core }) => {
  const a = core.chat('alpha');
  append(a.file, rec.user('shared needle in alpha'));
  const b = core.chat('beta');
  append(b.file, rec.user('shared needle in beta'));
  const c = codexSession(core, 'gamma');
  await expect.poll(() => snap(core).find((s) => s.id === c.id)?.agent_session_id).toBe(c.thread);
  append(c.file, codexRec('user', 'shared needle in gamma'));
  core.cli('session', 'close', b.id);
  const asked = await record(page);
  await openSessions(page);
  await find(page, 'shared needle');
  await expect(stat(page)).toHaveText('3 matches in 3 sessions');
  await panel(page).getByRole('combobox', { name: 'Project' }).selectOption({ label: 'alpha' });
  await expect(stat(page)).toHaveText('1 match in 1 session');
  await expect(group(page, a.id)).toBeVisible();
  await panel(page).getByRole('combobox', { name: 'Project' }).selectOption({ label: 'All projects' });
  await panel(page).getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'Codex' });
  await expect(stat(page)).toHaveText('1 match in 1 session');
  await expect(group(page, c.id)).toBeVisible();
  await panel(page).getByRole('combobox', { name: 'Agent' }).selectOption({ label: 'All agents' });
  await expect(stat(page)).toHaveText('3 matches in 3 sessions');
  const from = asked.length;
  await panel(page).getByRole('checkbox', { name: 'Closed too' }).uncheck();
  await expect(stat(page)).toHaveText('2 matches in 2 sessions');
  await expect(group(page, b.id)).toHaveCount(0);
  // The window sends only the sessions its filters keep.
  expect([...new Set(asked.slice(from).flatMap((x) => x.sessions))].sort()).toEqual([a.id, c.id].sort());
  await panel(page).getByRole('checkbox', { name: 'Closed too' }).check();
  // Dates: seen from 40 days on, every session is older than 30 days; "Any date" finds them again.
  await expect(panel(page).getByRole('combobox', { name: 'Date' })).toHaveValue('30');
  await panel(page).getByRole('combobox', { name: 'Date' }).selectOption({ label: 'Any date' });
  await expect(stat(page)).toHaveText('3 matches in 3 sessions');
  await page.clock.setFixedTime(Date.now() + 40 * 86_400_000);
  await panel(page).getByRole('combobox', { name: 'Date' }).selectOption({ label: 'Last 30 days' });
  await expect(stat(page)).toContainText('No matches');
  await expect(panel(page)).toContainText('Only sessions started in Nunchiro are searched');
  await panel(page).getByRole('button', { name: 'Search all dates' }).click();
  await expect(stat(page)).toHaveText('3 matches in 3 sessions');
  // Files scope is the existing Search, unchanged: its own field and empty state.
  await panel(page).getByRole('radio', { name: 'Files' }).click();
  await expect(field(page)).toHaveAttribute('placeholder', 'exact text, case-sensitive');
  await panel(page).getByRole('radio', { name: 'Sessions' }).click();
  await expect(field(page)).toHaveValue('shared needle');
  await page.screenshot({ path: path.join(REPO, '.scratch/shots', `v2-7-filters-${test.info().project.name}.png`) });
});

test('search_sessions: a missing transcript says so; an empty result names what is searched', async ({ page, chatCore: core }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('present needle'));
  const gone = codexSession(core, 'beta');
  await expect.poll(() => snap(core).find((r) => r.id === gone.id)?.agent_session_id).toBe(gone.thread);
  fs.rmSync(gone.file);
  await openSessions(page);
  await find(page, 'present needle');
  await expect(group(page, s.id)).toBeVisible();
  await expect(group(page, gone.id)).toContainText('transcript missing');
  await find(page, 'nothing like this');
  await expect(stat(page)).toContainText('No matches for “nothing like this”');
  await expect(panel(page)).toContainText('Only sessions started in Nunchiro are searched');
  await expect(panel(page).getByRole('button', { name: 'Search files instead' })).toBeVisible();
});

test('search_hangul_enter_does_not_search: Enter during Hangul composition does not run the search', async ({ page, chatCore: core, browserName }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('눈치로 검색 확인'));
  const asked = await record(page);
  await openSessions(page);
  await field(page).focus();
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '눈', selectionStart: 1, selectionEnd: 1 });
    await page.waitForTimeout(400);
    expect(asked).toEqual([]);
    // Ends the composition without text; the field is set below.
    await cdp.send('Input.insertText', { text: '' });
  }
  // The Enter that commits a syllable must not search: Chrome sends it during composition (isComposing), Safari
  // right after compositionend with keyCode 229. Text is in the field, so a missed guard would search at once
  // (the pause after composition waits 300 ms).
  await field(page).evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await field(page).fill('눈치로');
  await field(page).evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '로' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
  });
  await page.waitForTimeout(100);
  expect(asked).toEqual([]);
  await field(page).press('Enter');
  await expect.poll(() => asked.map((a) => a.query)).toContain('눈치로');
  await expect(group(page, s.id).getByRole('option').locator('mark')).toHaveText('눈치로');
});

test('search_sessions: the palette opens Search in the Sessions scope with its field focused', async ({ page, chatCore: core }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('palette needle'));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  // The key binding is live a moment after the window connects (WebKit loses a first press): press until the palette is there.
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press('Meta+KeyK');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await dialog.locator('[data-command="search.sessions"]').click();
  await expect(panel(page).getByRole('radio', { name: 'Sessions' })).toHaveAttribute('aria-checked', 'true');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('palette needle');
  await page.keyboard.press('Enter');
  await expect(group(page, s.id).getByRole('option')).toHaveCount(1);
});

// Ticket 1130 C3 (p04 T5, 6 steps to 3): the chord focuses Search sessions, the typed word finds the chat, Enter opens its first hit.
test('chord_word_enter_opens_first_hit', async ({ page, chatCore: core }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('filler'), rec.assistant('the chord needle lives here'));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // The key binding is live a moment after the window connects (WebKit loses a first press): press until the field is there.
  await expect(async () => {
    if (!(await field(page).isVisible())) await page.keyboard.press('Alt+Meta+KeyF');
    await expect(field(page)).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(panel(page).getByRole('radio', { name: 'Sessions' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.type('chord needle');
  await expect(group(page, s.id).getByRole('option')).toHaveCount(1);
  await expect(panel(page).locator('.shint')).toHaveText('Enter opens the first result');
  await page.keyboard.press('Enter');
  await expect(page.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(chat(page, s.id).locator('.crow[data-hit]')).toContainText('the chord needle lives here');
});

test('query_without_plain_character_is_refused: quotes, backslashes and control characters alone are not sent', async ({ page, chatCore: core }) => {
  const s = core.chat('alpha');
  append(s.file, rec.user('say a"b here'));
  const asked = await record(page);
  await openSessions(page);
  for (const q of ['"', '\\', '"\\"', '\u0001']) {
    await find(page, q);
    await expect(panel(page).getByRole('alert')).toHaveText('Use at least one letter or digit in the search text');
  }
  await page.waitForTimeout(400);
  expect(asked).toEqual([]);
  // Its longest plain run is `a`, so it still searches.
  await find(page, 'a"b');
  await expect(group(page, s.id).getByRole('option')).toHaveCount(1);
  expect(asked.map((a) => a.query)).toEqual(['a"b']);
});

test('no_paging_after_unmount: closing Search stops the scan from asking for its next page', async ({ page, chatCore: core }) => {
  // One page ends at the first session with results, so four such sessions are four pages.
  for (const label of ['a', 'b', 'c', 'd']) append(core.chat(label).file, rec.user(`paged needle ${label}`));
  const warned: string[] = [];
  page.on('console', (m) => ['warning', 'error'].includes(m.type()) && warned.push(m.text()));
  page.on('pageerror', (e) => warned.push(e.message));
  const asked = await record(page);
  await openSessions(page);
  asked.hold.on = true;
  await find(page, 'paged needle');
  // The core's reply to page 1 is held; the window has not seen it yet.
  await expect.poll(() => asked.hold.kept.length).toBe(1);
  expect(asked).toHaveLength(1);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  asked.hold.release();
  await page.waitForTimeout(800);
  expect(asked).toHaveLength(1);
  expect(warned).toEqual([]);
});

test('chat_find_and_copy_thread (Q7 point 15): "Find in this chat" searches only the open chat; "Copy the whole chat" copies every message', async ({ page, chatCore: core }) => {
  // The clipboard as a recorder (WebKit has no clipboard-write permission). q67 look, Q7-15: in the app the copy failed
  // ("Chat not copied") because the write began after the chat was read, when WebKit's key press was over. The write must
  // begin at once, with a ClipboardItem whose text arrives later (`write`); a late `writeText` is the old path.
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: string[]; __late: string[]; __refuse?: boolean };
    w.__clip = [];
    w.__late = [];
    const write = async (items: ClipboardItem[]) => {
      if (w.__refuse) throw new Error('NotAllowedError');
      w.__clip.push(await (await items[0].getType('text/plain')).text());
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText: async (t: string) => void w.__late.push(t) } });
  });
  const here = core.chat('here');
  const there = core.chat('there');
  append(here.file, rec.user('fix the parser'), rec.assistant('The parser is fixed.'));
  append(there.file, rec.user('the parser elsewhere'), rec.assistant('Other parser.'));
  const asked = await record(page);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${here.id}"]`).click();
  const palette = async (name: string) => {
    await page.keyboard.press('Meta+KeyK');
    await page.getByRole('dialog').getByRole('combobox').fill(name);
    await page.keyboard.press('Enter');
  };
  await palette('Find in this chat');
  await expect(field(page)).toHaveAccessibleName('Search sessions');
  await expect(panel(page).getByRole('combobox', { name: 'Project' })).toHaveValue(`session:${here.id}`);
  await find(page, 'parser');
  await expect(group(page, here.id)).toBeVisible();
  await expect(group(page, there.id)).toHaveCount(0);
  expect(asked.at(-1)?.sessions).toEqual([here.id]);
  // A plain "Search sessions" lifts the scope.
  await palette('Search sessions');
  await expect(panel(page).getByRole('combobox', { name: 'Project' })).toHaveValue('');
  await page.locator(`.tab[data-tab="${here.id}"]`).click();
  await palette('Copy the whole chat');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clip: string[] }).__clip)).toEqual([`you:\nfix the parser\n\nhere:\nThe parser is fixed.`]);
  expect(await page.evaluate(() => (window as unknown as { __late: string[] }).__late)).toEqual([]);
  await expect(page.locator('footer.status .pane-status')).toHaveText('Copied');
  // A refused write says so, in the window's language: the note goes when the language changes (it stayed English in
  // the es, fr and ko windows), and the next failure reads in the new one.
  await page.evaluate(() => void ((window as unknown as { __refuse: boolean }).__refuse = true));
  await palette('Copy the whole chat');
  const note = page.locator('footer.status .pane-status');
  await expect(note).toContainText('Chat not copied: That did not work.');
  await page.keyboard.press('Meta+Comma');
  await page.locator('button[data-page="general"]').click();
  await page.locator('[data-setting="language"]').selectOption('fr');
  await expect(note).toHaveText('');
  await page.keyboard.press('Meta+Comma'); // closes Settings; the chat is still the active tab
  await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog').getByRole('combobox').fill('Copier toute la conversation');
  await page.keyboard.press('Enter');
  await expect(note).toContainText('Conversation non copiée');
});
