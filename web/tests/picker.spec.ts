// Ticket 10, window half: the model and effort chips, with fake agents (crates/nunchiro/tests/fixtures).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { CLAUDE_MODELS, CODEX_MODELS } from '../src/picker/catalog';
import { blocked } from '../src/picker/blocked';
import { makeT } from './i18n-tables';
import type { Session } from '../src/types';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
function fakeAgents(core: Core) {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  // codex-picker draws Codex's input box (since V1A-24 the core refuses a Codex switch until it sees one) and
  // redraws it on SIGWINCH, as real Codex does.
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
}
const start = (core: Core, kind: string, ...flags: string[]) =>
  core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind, ...flags).session as { id: string };
const reads = (core: Core, id: string) =>
  (fs.existsSync(path.join(core.home, `stdin-${id}.log`)) ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8') : '')
    .split('\n')
    .filter((l) => l.startsWith('READ '))
    .map((l) => l.slice(5));
const switches = (core: Core) =>
  fs
    .readFileSync(path.join(core.home, 'core.log'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('switch session='));
const chip = (page: Page, menu: 'model' | 'effort') => page.locator(`[data-picker="${menu}"]`);
const menu = (page: Page, which: 'model' | 'effort') => page.locator(`[data-menu="${which}"]`);
type Key = { code: string; key: string; ctrlKey?: boolean; metaKey?: boolean };
const physical = (page: Page, init: Key) =>
  page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);

// Ticket 358: a hand-off starts a new session, so an agent turned off is not offered.
test('picker hand-off leaves out an agent that is off', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude');
  await openWindow(app);
  await chip(app, 'model').click();
  await menu(app, 'model').locator('[data-item="more"]').click(); // W35: the hand-off group is under More models ›
  await expect(menu(app, 'model').locator('[data-item="handoff-codex"]')).toHaveCount(1);
  await app.evaluate(() => {
    const key = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...s, features: { ...s.features, 'agents.off': ['codex'] } }));
  });
  await app.reload();
  await chip(app, 'model').click();
  await expect(menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' })).toBeVisible();
  await menu(app, 'model').locator('[data-item="more"]').click();
  await expect(menu(app, 'model').locator('[data-item="handoff-claude"]')).toHaveCount(0); // a Claude session hands off to others only
  await expect(menu(app, 'model').locator('[data-item="handoff-codex"]')).toHaveCount(0);
});

test('picker click sends one SwitchModel', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'haiku');
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('switch_model') && sent.push(f.payload)));
  await openWindow(app);
  await expect(chip(app, 'model')).toHaveText('Claude · Haiku'); // the ▾ is an Octicon now (STYLE 2026-10-28)
  await expect(chip(app, 'model').locator('svg[data-icon="triangle-down"]')).toHaveCount(1);
  await expect(chip(app, 'effort')).toHaveText('effort default');
  await expect.poll(() => core.read(s.id)).toContain('❯');
  // Opening, hovering, browsing and closing both menus sends nothing.
  await chip(app, 'model').click();
  await expect(menu(app, 'model').getByRole('menuitemradio')).toHaveCount(4); // W35 mockup 2: the four aliases, no Default row
  await menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' }).hover();
  await app.keyboard.press('Escape');
  await chip(app, 'model').click();
  await chip(app, 'model').click();
  await chip(app, 'effort').focus();
  await app.keyboard.press('ArrowDown');
  // A running Claude session offers levels only ("Default" would leave Claude's effort as it is).
  await expect(menu(app, 'effort').getByRole('menuitemradio')).toHaveCount(5);
  await expect(menu(app, 'effort').getByRole('menuitemradio', { name: 'low' })).toBeFocused();
  await app.keyboard.press('ArrowDown');
  await expect(menu(app, 'effort').getByRole('menuitemradio', { name: 'medium' })).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(menu(app, 'effort')).toHaveCount(0);
  await expect(chip(app, 'effort')).toBeFocused();
  // Anything the browsing had sent would show up in the totals checked at the end.
  // One click: one request, one picker batch (opened by meta+p, confirmed once with `s`), one log line.
  await chip(app, 'model').click();
  await menu(app, 'model').getByRole('menuitemradio', { name: 'Sonnet' }).click();
  await expect(chip(app, 'model')).toHaveText('Claude · Sonnet');
  await expect.poll(() => sent.length).toBe(1);
  expect(JSON.parse(sent[0]).request).toEqual({ op: 'switch_model', id: s.id, model: 'sonnet', effort: null });
  expect(reads(core, s.id).filter((r) => r === '1b70')).toHaveLength(1);
  expect(reads(core, s.id).filter((r) => r === '73')).toHaveLength(1);
  await expect.poll(() => switches(core).length).toBe(1);
  // Effort by keyboard: Enter on a focused item is the click (once the first switch has finished).
  await expect(chip(app, 'effort')).toHaveAttribute('aria-disabled', 'false');
  await chip(app, 'effort').focus();
  await app.keyboard.press('ArrowDown');
  await expect(menu(app, 'effort').getByRole('menuitemradio', { name: 'low' })).toBeFocused();
  await app.keyboard.press('End'); // the Ultracode switch is the last row (W35)
  await app.keyboard.press('ArrowUp');
  await app.keyboard.press('ArrowUp');
  await expect(menu(app, 'effort').getByRole('menuitemradio', { name: 'xHigh' })).toBeFocused();
  await app.keyboard.press('Enter');
  await expect(chip(app, 'effort')).toHaveText('effort xHigh');
  await expect.poll(() => switches(core).length).toBe(2);
  // Two clicks in all: two requests, two picker batches, and nothing from opening or browsing the menus.
  await expect.poll(() => sent.length).toBe(2);
  expect(JSON.parse(sent[1]).request).toEqual({ op: 'switch_model', id: s.id, model: 'sonnet', effort: 'xhigh' });
  // Every byte the agent ever read: the two picker batches and nothing else (no menu key reached the PTY).
  // Haiku -> Sonnet: open, leave search, up one row, confirm. Then effort medium -> xHigh: open, leave search,
  // right twice, confirm.
  expect(reads(core, s.id)).toEqual(['1b70', '1b5b42', '1b5b41', '73', '1b70', '1b5b42', '1b5b43', '1b5b43', '73']);
});

test('picker: a Codex switch resumes the conversation and the tab follows it', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'codex', '--model', 'gpt-6-luna', '--effort', 'medium');
  await expect.poll(() => core.cli('snapshot', '--json').sessions[0].agent_session_id).toBe('FAKE-CODEX-123');
  await openWindow(app);
  await expect(chip(app, 'model')).toHaveText('Codex · GPT-6 Luna');
  // AGENTVIEW: the agent redraws when the window fits its terminal, which lives in the side pane.
  await app.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect.poll(() => core.screen(s.id)).toContain('gpt-fixture redrawn');
  await chip(app, 'effort').click();
  await menu(app, 'effort').getByRole('menuitemradio', { name: 'low' }).click();
  await expect(chip(app, 'effort')).toHaveText('effort low');
  const next = core.cli('snapshot', '--json').sessions.find((x: { state: string }) => x.state === 'running');
  expect(next.id).not.toBe(s.id);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', next.id);
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toHaveCount(0);
});

test('picker: says why it cannot switch; a shell session has no picker', async ({ app, core }) => {
  fakeAgents(core);
  const shell = core.shell(core.project('demo'), 'sh');
  const s = start(core, 'claude');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${shell.id}"]`).click();
  await expect(app.locator('.pk-chip')).toHaveCount(0);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  // Text the user left in Claude's own input box: the core refuses and the chip row says why.
  await app.getByRole('button', { name: 'Terminal', exact: true }).click(); // the Right bar's Terminal icon: the side pane
  await app.locator(`.term[data-session="${s.id}"]`).click();
  // A click before the terminal opens (it opens once its replay is in) still focuses it when it opens; keys wait for that.
  await expect(app.locator(`.term[data-session="${s.id}"] .xterm-helper-textarea`)).toBeFocused();
  await app.keyboard.type('draft');
  await expect.poll(() => app.locator(`.term[data-session="${s.id}"] .xterm-rows`).innerText()).toContain('❯ draft');
  await chip(app, 'model').click();
  await menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' }).click();
  await expect(app.locator('.pk-msg[data-error]')).toContainText("text is in Claude's input box");
  expect(reads(core, s.id).filter((r) => r === '1b70')).toHaveLength(0);
});

test('picker_failure_message_clears_on_handoff', async ({ app, core }) => {
  fakeAgents(core);
  // `--fixture-picker=newer` draws a picker the core does not recognise, so a Claude model pick fails.
  start(core, 'claude', '--model', 'haiku', '--', '--fixture-picker=newer');
  await openWindow(app);
  await chip(app, 'model').click();
  await menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' }).click();
  const msg = app.locator('.pk-msg[data-error]');
  // The text says what to do next: check the terminal, press Esc, try again.
  await expect(msg).toContainText('switch failed');
  await expect(msg).toContainText('check the terminal');
  await expect(msg).toContainText('Esc');
  await expect(msg).toContainText('try again');
  // Shots for REPORT: the composer after the failed switch and after the hand-off, light then dark.
  const out = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(out, { recursive: true });
  const shot = (name: string) => app.locator('.composer').screenshot({ path: path.join(out, `picker-${name}.png`) });
  await app.emulateMedia({ colorScheme: 'light' });
  await shot('failed-light');
  await app.emulateMedia({ colorScheme: 'dark' });
  await shot('failed-dark');
  // Choosing a hand-off row is the owner moving on: the stale failure goes away at once.
  await chip(app, 'model').click();
  await menu(app, 'model').locator('[data-item="more"]').click();
  await menu(app, 'model').locator('[data-item="handoff-codex"]').click();
  await expect(app.locator('.pk-msg')).toHaveCount(0);
  await shot('handoff-dark');
  await app.emulateMedia({ colorScheme: 'light' });
  await shot('handoff-light');
});

test('picker: the reason a switch cannot start', () => {
  const t = makeT('en', 'en');
  const session = (over: object) => ({ state: 'running', pending: [], attention: { working: false, waiting: false, stale: false, failed: false }, ...over }) as unknown as Session;
  expect(blocked(t, null, true, false)).toBe('open a session first');
  expect(blocked(t, session({}), false, false)).toBe('disconnected from Nunchiro');
  expect(blocked(t, session({}), true, true)).toBe('switching…');
  expect(blocked(t, session({ state: 'exited' }), true, false)).toBe('the session is not running');
  expect(blocked(t, session({ attention: { working: true } }), true, false)).toBe('switch when the agent is idle (now working)');
  expect(blocked(t, session({}), true, false)).toBeNull();
});

// Ticket 810 (walk 10): the reasons were English literals in a Korean window, as the chip's tooltip and accessible name.
test('picker_reason_follows_the_window_language: Korean reasons, the status word too', () => {
  const t = makeT('ko', 'en');
  const session = (over: object) => ({ state: 'running', pending: [], attention: { working: false, waiting: false, stale: false, failed: false }, ...over }) as unknown as Session;
  expect(blocked(t, session({ state: 'exited' }), true, false)).toBe('세션이 실행 중이 아닙니다');
  expect(blocked(t, session({ attention: { working: true } }), true, false)).toBe(`에이전트가 쉬고 있을 때 바꾸세요 (지금: ${t('mw.status.working')})`);
  expect(t('mw.status.working')).not.toBe('working');
});

test('picker: Hangul composition survives opening the menu; prefix keys still work from the menu', async ({ app, core, browserName }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'haiku');
  await openWindow(app);
  const box = app.locator('#composer');
  await box.click();
  if (browserName === 'chromium') {
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.imeSetComposition', { text: '누', selectionStart: 1, selectionEnd: 1 });
    await chip(app, 'model').click();
    await expect(menu(app, 'model')).toBeVisible();
    await expect(box).toBeFocused();
    await cdp.send('Input.insertText', { text: '눈' });
    await expect(box).toHaveValue('눈');
    await app.mouse.click(5, 5);
    await expect(menu(app, 'model')).toHaveCount(0);
  }
  // Menu keys are physical codes: a Korean input source's key values do not matter.
  await chip(app, 'effort').focus();
  await physical(app, { code: 'ArrowDown', key: 'ArrowDown' });
  await expect(menu(app, 'effort')).toBeVisible();
  await physical(app, { code: 'Escape', key: 'Escape' });
  await expect(menu(app, 'effort')).toHaveCount(0);
  await chip(app, 'effort').focus();
  await physical(app, { code: 'ArrowDown', key: 'ArrowDown' });
  await physical(app, { code: 'Space', key: ' ', ctrlKey: true });
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await app.keyboard.press('Escape');
  await physical(app, { code: 'KeyK', key: 'ㅏ', metaKey: true });
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});

test('picker: the window catalog equals the core allowlist', async () => {
  const rust = fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/src/sessions.rs'), 'utf8');
  const claude = [...rust.slice(rust.indexOf('const CLAUDE_MODELS'), rust.indexOf('const CLAUDE_EFFORTS')).matchAll(/\("([^"]+)", "[^"]+"\)/g)].map((m) => m[1]);
  expect(claude).toEqual(CLAUDE_MODELS.map((m) => m.value));
  const codexBlock = rust.slice(rust.indexOf('const CODEX_MODELS'), rust.indexOf('const PICKER_OPEN'));
  const codex = [...codexBlock.matchAll(/\(\s*"([^"]+)",\s*&\[([^\]]+)\],?\s*\)/g)].map((m) => [m[1], m[2].split(/,\s*/).map((e) => e.replaceAll('"', ''))]);
  expect(codex).toEqual(CODEX_MODELS.map((m) => [m.value, m.efforts]));
});

test('picker shots: composer with each menu open', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'opus', '--effort', 'high');
  await openWindow(app);
  const out = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(out, { recursive: true });
  await expect(chip(app, 'model')).toHaveText('Claude · Opus');
  await app.locator('.composer').screenshot({ path: path.join(out, 'picker-chips.png') });
  for (const which of ['model', 'effort'] as const) {
    await chip(app, which).click();
    await expect(menu(app, which)).toBeVisible();
    const box = (await app.locator('.composer').boundingBox())!;
    await app.screenshot({ path: path.join(out, `picker-${which}-menu.png`), clip: { x: box.x, y: box.y - 230, width: box.width, height: box.height + 230 } });
    await app.keyboard.press('Escape');
  }
});
