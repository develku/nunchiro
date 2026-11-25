// W35 picker (owner 11-20, mockup docs/design/model-picker-1120 mockup 2): the model chip's menu with digits, More models and
// Claude's Fast mode; the effort chip's own menu with Ultracode. Fake agents only (crates/nunchiro/tests/fixtures).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
function fakeAgents(core: Core) {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
}
const start = (core: Core, kind: string, ...flags: string[]) =>
  core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind, ...flags).session as { id: string };
const chip = (page: Page, menu: 'model' | 'effort') => page.locator(`.composer [data-picker="${menu}"]`);
const menu = (page: Page, which: 'model' | 'effort' | 'more') => page.locator(`[data-menu="${which}"]`);
/** What the chip draws (the agent word is in its tooltip only). */
const drawn = (page: Page, which: 'model' | 'effort') => chip(page, which).evaluate((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim());
const rows = (page: Page, which: 'model' | 'effort') =>
  menu(page, which).locator(':scope > [role="menuitemradio"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));
/** Fable SHOULD 7: a shot of the composer with whatever menu is open, for the mockup comparison. */
const shot = async (page: Page, name: string) => {
  const out = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(out, { recursive: true });
  const box = (await page.locator('.composer').boundingBox())!;
  await page.screenshot({ path: path.join(out, `picker-modes-${name}.png`), clip: { x: Math.max(0, box.x + box.width - 760), y: Math.max(0, box.y - 380), width: Math.min(760, box.x + box.width), height: box.height + 380 } });
};
/** One finished turn as Claude's hooks report it (fast mode waits for the first reply). */
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
const firstReply = (core: Core, id: string) => {
  for (const event of ['UserPromptSubmit', 'Stop']) execFileSync(process.execPath, ['-e', HOOK, core.home, id, event]);
};
const watch = (page: Page) => {
  const sent: Record<string, unknown>[] = [];
  page.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && f.payload.includes('switch_model') && sent.push(JSON.parse(f.payload).request)));
  return sent;
};

test('picker_modes_claude: chips, menus, digits, fast mode per session by a restart, ultracode typed', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'opus', '--effort', 'high', '--', '--fixture-footer'); // the footer names the mode a fast restart keeps
  const sent = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  // Frame A: the model and the level, no agent or "effort" word drawn.
  await expect.poll(() => drawn(app, 'model')).toBe('Opus');
  await expect.poll(() => drawn(app, 'effort')).toBe('high');
  await expect(chip(app, 'model')).toHaveAttribute('title', /Claude · Opus/);
  // Frame B: four aliases with digits, Opus first, More models, then the Fast mode section.
  await chip(app, 'model').click();
  expect(await rows(app, 'model')).toEqual(['Opus ✓ 1', 'Fable 2', 'Sonnet 3', 'Haiku 4']);
  await expect(menu(app, 'model').locator('[data-item="more"]')).toHaveText(/More models/);
  const fast = menu(app, 'model').locator('[data-toggle="fast"]');
  await expect(fast).toHaveAttribute('aria-checked', 'false');
  // Codex round-6 MUST: before the first reply there is no conversation to resume.
  await expect(fast).toHaveAttribute('aria-disabled', 'true');
  await expect(menu(app, 'model').locator('.pk-help')).toHaveText('Fast mode is available after the first reply.');
  firstReply(core, s.id);
  await expect(fast).not.toHaveAttribute('aria-disabled', 'true');
  // More models › opens beside the menu with the hand-off group; ← closes it, Esc then closes the menu.
  await menu(app, 'model').locator('[data-item="more"]').click();
  await expect(menu(app, 'more').locator('[data-item="handoff-codex"]')).toBeFocused();
  await app.keyboard.press('ArrowLeft');
  await expect(menu(app, 'more')).toHaveCount(0);
  await expect(menu(app, 'model').locator('[data-item="more"]')).toBeFocused();
  // Frame C: the effort menu: help, five levels with digits, max flagged, Ultracode off as Claude's settings start it
  // (ticket 1018: no longer "not read yet").
  await app.keyboard.press('Escape');
  await expect(menu(app, 'model')).toHaveCount(0);
  await chip(app, 'effort').click();
  await expect(menu(app, 'effort').locator('.pk-help')).toContainText('uses your limits faster');
  expect(await rows(app, 'effort')).toEqual(['low 1', 'medium 2', 'high ✓ 3', 'xHigh 4', 'max ⚠ uses limits fastest 5']);
  const ultra = menu(app, 'effort').locator('[data-toggle="ultracode"]');
  await expect(ultra).toHaveAttribute('aria-checked', 'false');
  await expect(ultra).not.toContainText('not read yet');
  // A pick sets it: one /effort ultracode on, typed as a send row; the chip then says so.
  await ultra.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ op: 'switch_model', id: s.id, model: 'opus', effort: 'high', ultracode: true });
  await expect.poll(() => core.read(s.id)).toContain('SUBMIT:/effort ultracode on');
  await expect.poll(() => drawn(app, 'effort')).toBe('high · ultracode');
  await expect(chip(app, 'effort')).toHaveAttribute('title', /high · ultracode/); // SHOULD 4: the tooltip says it too
  await chip(app, 'effort').click();
  await shot(app, 'effort-ultracode-on');
  await app.keyboard.press('Escape');
  // Fast mode: the row says it restarts before the click; Claude restarts into this conversation with ↯ (nothing typed into it).
  await chip(app, 'model').click();
  await expect(menu(app, 'model').locator('.pk-help')).toHaveText('Restarts Claude and resumes this conversation, for this session only.');
  await menu(app, 'model').locator('[data-toggle="fast"]').click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({ op: 'switch_model', id: s.id, model: 'opus', effort: 'high', fast: true });
  await expect.poll(() => drawn(app, 'model')).toBe('Opus ↯');
  await expect.poll(() => drawn(app, 'effort')).toBe('high · ultracode');
  await chip(app, 'model').click();
  await expect(menu(app, 'model').locator('[data-toggle="fast"]')).toHaveAttribute('aria-checked', 'true');
  await expect(menu(app, 'model').locator('[data-toggle="fast"] .pk-pill')).toHaveText('usage credits');
  await expect(chip(app, 'model')).toHaveAttribute('title', /fast mode on/);
  await shot(app, 'model-fast-on');
  // A digit picks its row at once: 3 is Sonnet.
  await app.keyboard.press('Escape');
  await chip(app, 'model').focus();
  await app.keyboard.press('ArrowDown');
  await expect(menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' })).toBeFocused();
  await app.keyboard.press('Digit3');
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ op: 'switch_model', model: 'sonnet' });
});

test('picker_modes_fast_draft_confirm: a draft in the box asks once before the restart', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'opus', '--', '--fixture-footer'); // the footer names the mode a fast restart keeps
  const sent = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  firstReply(core, s.id);
  await app.locator('#composer').fill('half a thought');
  await chip(app, 'model').click();
  await menu(app, 'model').locator('[data-toggle="fast"]').click();
  await expect(menu(app, 'model').locator('.pk-help').last()).toHaveText('A draft is in the box. Restart Claude and resume this conversation anyway?');
  await app.waitForTimeout(300);
  expect(sent).toEqual([]);
  await menu(app, 'model').locator('[data-item="fast-restart"]').click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ op: 'switch_model', fast: true });
  // The draft follows the restarted session's tab.
  await expect(app.locator('.tab[aria-selected="true"]')).not.toHaveAttribute('data-tab', s.id);
  await app.waitForTimeout(500); // the box has met the new id
  await expect(app.locator('#composer')).toHaveValue('half a thought');
});

test('picker_modes_default_pill: on the model the user\'s own settings name, none when they name none', async ({ app, core }) => {
  // W35-picker2 S3: the user's default, read with the versions (usage_detail), not the session's launch model.
  fakeAgents(core);
  start(core, 'claude', '--model', 'sonnet');
  await openWindow(app);
  await chip(app, 'model').click();
  await expect(menu(app, 'model').locator('.pk-pill')).toHaveCount(0); // the settings name no model: unknown
  await app.keyboard.press('Escape');
  fs.mkdirSync(path.join(core.home, 'claude-home'), { recursive: true });
  fs.writeFileSync(path.join(core.home, 'claude-home/settings.json'), JSON.stringify({ model: 'fable' }));
  await app.reload();
  await chip(app, 'model').click();
  await expect.poll(() => rows(app, 'model')).toEqual(['Opus 1', 'Fable Default 2', 'Sonnet ✓ 3', 'Haiku 4']);
});

test('picker_modes_launch_model_and_reported_effort: the chip names a launch --model before any reply; the menu ticks the reported level', async ({ app, core }) => {
  // W35-picker2 S3: `agent start -- --model haiku` (the CLI passthrough) and an effort the agent reported, none picked.
  fakeAgents(core);
  const s = start(core, 'claude', '--', '--model', 'haiku', '--fixture-transcript');
  await openWindow(app);
  await expect.poll(() => drawn(app, 'model')).toBe('Haiku');
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await app.locator('#composer').fill('hi');
  await app.keyboard.press('Enter');
  await expect.poll(() => core.read(s.id)).toContain('SUBMIT:hi');
  const ctx = path.join(core.home, 'claude-home/projects');
  await expect.poll(() => fs.existsSync(ctx) && fs.readdirSync(ctx).length).toBeTruthy();
  await app.reload(); // the fake writes the turn's records at once; the window reads the context as it opens
  await expect.poll(() => drawn(app, 'effort'), { timeout: 15000 }).toBe('medium');
  await chip(app, 'effort').click();
  await expect(menu(app, 'effort').locator('[role="menuitemradio"][aria-checked="true"]')).toHaveText(/medium/);
});

test('picker_modes_more_opens_right_flips_left_without_room', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'opus');
  await openWindow(app);
  const side = async () => {
    await app.keyboard.press('Escape'); // a retry starts with no menu open
    // By keys: at 680 px the tree's sidebar lies over the menu's left part, so a pointer could not reach every row.
    await chip(app, 'model').focus();
    await app.keyboard.press('ArrowDown');
    await expect(menu(app, 'model').getByRole('menuitemradio', { name: 'Opus' })).toBeFocused();
    await app.keyboard.press('ArrowUp'); // wraps to the last row (Enable fast mode), then up to More models
    await app.keyboard.press('ArrowUp');
    await expect(menu(app, 'model').locator('[data-item="more"]')).toBeFocused();
    await app.keyboard.press('ArrowRight');
    await expect(menu(app, 'more')).toBeVisible();
    const [m, sub] = [(await menu(app, 'model').boundingBox())!, (await menu(app, 'more').boundingBox())!];
    const vw = await app.evaluate(() => document.documentElement.clientWidth);
    expect(sub.x).toBeGreaterThanOrEqual(0); // inside the window, whichever side
    expect(sub.x + sub.width).toBeLessThanOrEqual(vw);
    await app.keyboard.press('Tab');
    return sub.x >= m.x + m.width ? 'right' : sub.x + sub.width <= m.x ? 'left' : 'over';
  };
  // A side is read until it holds: right after a resize or the submenu's opening, the layout may not have settled yet.
  const settled = (want: string) => expect.poll(side, { timeout: 15000 }).toBe(want);
  await settled('right');
  // Mockup E's 680 px: the chips sit mid-window, so the right side still has room.
  await app.setViewportSize({ width: 680, height: 800 });
  await settled('right');
  // No room to the right (nor, here, to the left): it opens over the menu, still inside the window.
  await app.setViewportSize({ width: 560, height: 800 });
  await settled('over');
});

test('picker_modes_more_by_keys: up and down stay in More models, every row reachable, a digit picks nothing', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'opus');
  const sent = watch(app);
  await openWindow(app);
  await chip(app, 'model').click();
  await menu(app, 'model').locator('[data-item="more"]').click();
  const rowsIn = menu(app, 'more').locator(':scope > [role="menuitem"], :scope > [role="menuitemradio"]');
  const n = await rowsIn.count();
  await expect(rowsIn.first()).toBeFocused();
  for (let i = 1; i < n; i++) {
    await app.keyboard.press('ArrowDown');
    await expect(rowsIn.nth(i)).toBeFocused();
  }
  await expect(menu(app, 'more').locator('[data-item="manage"]')).toBeFocused();
  await app.keyboard.press('ArrowDown'); // wraps inside More
  await expect(rowsIn.first()).toBeFocused();
  await app.keyboard.press('End');
  await expect(rowsIn.last()).toBeFocused();
  await app.keyboard.press('Home');
  await expect(rowsIn.first()).toBeFocused();
  await app.keyboard.press('Digit2'); // main row 2 is not this menu's
  await app.waitForTimeout(300);
  expect(sent).toEqual([]);
  await expect(menu(app, 'more')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(menu(app, 'model').locator('[data-item="more"]')).toBeFocused();
});

test('picker_modes_ultracode_refused: Claude\'s own sentence, the switch never reads on', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'opus', '--', '--fixture-no-workflows');
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await chip(app, 'effort').click();
  await menu(app, 'effort').locator('[data-toggle="ultracode"]').click();
  await expect(app.locator('.pk-msg[data-error]')).toContainText('Ultracode needs dynamic workflows turned on');
  await expect.poll(() => drawn(app, 'effort')).toBe('default');
  await chip(app, 'effort').click();
  await expect(menu(app, 'effort').locator('[data-toggle="ultracode"]')).toHaveAttribute('aria-checked', 'false'); // as it started (ticket 1018)
  await expect(menu(app, 'effort').locator('.pk-help').last()).toContainText('Ultracode needs dynamic workflows');
});

for (const on of [true, false])
  test(`picker_modes_ultracode_read_from_settings: after a reply and idle the row reads ${on ? 'on' : 'off'}`, async ({ app, core }) => {
    // Ticket 1018 (look v24 h S3-1): "not read yet" stayed after the first reply and 15 s idle. The row reads Ultracode as
    // Claude's own settings start the session (the account's settings.json here).
    fakeAgents(core);
    fs.mkdirSync(path.join(core.home, 'claude-home'), { recursive: true });
    fs.writeFileSync(path.join(core.home, 'claude-home/settings.json'), JSON.stringify({ ultracode: on }));
    const s = start(core, 'claude', '--model', 'opus');
    await openWindow(app);
    await expect.poll(() => core.read(s.id)).toContain('❯');
    firstReply(core, s.id);
    await expect.poll(() => drawn(app, 'effort')).toBe(on ? 'default · ultracode' : 'default');
    await chip(app, 'effort').click();
    const ultra = menu(app, 'effort').locator('[data-toggle="ultracode"]');
    await expect(ultra).toHaveAttribute('aria-checked', String(on));
    await expect(ultra).not.toContainText('not read yet');
  });

// Ticket 1010 (mockup 2, notes "Fast, cooldown" and "Fast, account refuses"): the fake Claude draws 2.1.330's own notices
// under its box. A pause: the switch stays on, the ↯ turns grey and says "cooling down", the row says why and until when.
// A refusal: the switch is off, with Claude's sentence under it and in the chip's message.
test('picker_modes_fast_cooldown_and_refusal: a pause greys the ↯ and names its end; a refusal turns the switch off with the reason', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'opus', '--', '--fixture-footer');
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  firstReply(core, s.id);
  await chip(app, 'model').click();
  await menu(app, 'model').locator('[data-toggle="fast"]').click();
  await expect.poll(() => drawn(app, 'model')).toBe('Opus ↯');
  const fast = menu(app, 'model').locator('[data-toggle="fast"]');
  const mark = chip(app, 'model').locator('.pk-fast');
  await expect(mark).toHaveAttribute('title', 'fast mode on');
  const onColour = await mark.evaluate((e) => getComputedStyle(e).color);
  // The restart made a new session: the fake reads its notice from fast-<that session>, once it runs (the chip's ↯ comes
  // with the restart's reply, before Claude draws).
  const other = () => fs.readdirSync(core.home).flatMap((f) => /^stdin-(.+)\.log$/.exec(f)?.[1] ?? []).find((id) => id !== s.id);
  await expect.poll(other).toBeTruthy();
  const restarted = other()!;
  await expect.poll(() => core.read(restarted)).toContain('↯');
  const say = (notice: string) => fs.writeFileSync(path.join(core.home, `fast-${restarted}`), notice);

  say('Fast limit reached, fast mode paused · resets in 5m');
  await expect(mark).toHaveAttribute('title', 'fast mode cooling down');
  await expect(mark).toHaveAttribute('aria-label', 'fast mode cooling down');
  await expect(chip(app, 'model')).toHaveAttribute('title', /Opus · fast mode cooling down ·/);
  await expect(chip(app, 'model')).not.toHaveAttribute('title', /fast mode on/); // a paused mark never reads as on
  await expect(chip(app, 'model')).toHaveAccessibleName('Model: Claude · Opus · fast mode cooling down');
  expect(await mark.evaluate((e) => getComputedStyle(e).color)).not.toBe(onColour);
  await chip(app, 'model').click();
  await expect(fast).toHaveAttribute('aria-checked', 'true');
  await expect(fast.locator('.pk-pill')).toHaveText('usage credits');
  const why = menu(app, 'model').locator('.pk-help').filter({ hasText: 'Fast limit reached' });
  await expect(why).toHaveText(/^Fast limit reached, fast mode paused · until .*\d:\d\d/); // Claude's words and a clock time
  expect(await mark.evaluate((e) => getComputedStyle(e).color)).toBe(await why.evaluate((e) => getComputedStyle(e).color)); // the grey of the menu's notes
  // The mockup's `.why`: the sentence sits right under its switch row.
  const [row, note] = [(await fast.boundingBox())!, (await why.boundingBox())!];
  expect(Math.abs(note.y - (row.y + row.height))).toBeLessThanOrEqual(1);
  expect(await why.evaluate((e) => getComputedStyle(e).paddingTop)).toBe('0px');
  await shot(app, 'model-fast-cooldown');

  say('Fast limit reset · now using fast mode');
  await expect(mark).toHaveAttribute('title', 'fast mode on');
  await expect(why).toHaveCount(0);

  say('Fast mode disabled · Out of usage credits');
  await expect(fast).toHaveAttribute('aria-checked', 'false');
  await expect(mark).toHaveCount(0);
  await expect(menu(app, 'model').locator('.pk-help').filter({ hasText: 'Fast mode disabled' })).toHaveText('Fast mode disabled · Out of usage credits');
  await expect(app.locator('.pk-msg[data-error]')).toHaveText('Fast mode disabled · Out of usage credits');
  await shot(app, 'model-fast-refused');
});

test('picker_modes_fast_off_a_fast_model: disabled with the reason', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'sonnet');
  await openWindow(app);
  await chip(app, 'model').click();
  const fast = menu(app, 'model').locator('[data-toggle="fast"]');
  await expect(fast).toHaveAttribute('aria-disabled', 'true');
  await expect(menu(app, 'model').locator('.pk-help')).toHaveText('Fast mode runs on Opus 5.5 or Fable 5.2. Pick one above first.');
  await shot(app, 'model-sonnet-fast-disabled');
  await fast.click({ force: true }); // a disabled row does nothing
  await expect(menu(app, 'model').locator('[data-item="fast-restart"]')).toHaveCount(0);
});

test('picker_modes_codex: Default and nine models with digits, reasoning levels, no fast or ultracode', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium');
  await openWindow(app);
  await expect.poll(() => drawn(app, 'model')).toBe('GPT-6.1-Sol'); // ticket 1100: Codex's own name
  await expect.poll(() => drawn(app, 'effort')).toBe('medium');
  await chip(app, 'model').click();
  const models = await rows(app, 'model');
  expect(models.slice(0, 3)).toEqual(['Default 1', 'GPT-6.1 Terra 2', 'GPT-6.1-Sol ✓ 3']);
  expect(models[8]).toMatch(/^GPT-\S+( \S+)? 9$/); // nine digits; the tenth row and on have none
  expect(models.length).toBeGreaterThanOrEqual(9);
  await expect(menu(app, 'model').locator('[data-toggle]')).toHaveCount(0);
  await app.keyboard.press('Escape');
  await chip(app, 'effort').click();
  await expect(menu(app, 'effort').locator('.pk-group')).toHaveText('Reasoning');
  expect(await rows(app, 'effort')).toEqual(['Default 1', 'low 2', 'medium ✓ 3', 'high 4', 'xHigh 5', 'max 6', 'ultra ⚠ uses limits fastest 7']);
  await shot(app, 'codex-reasoning');
  await expect(menu(app, 'effort').locator('[data-toggle]')).toHaveCount(0);
});

test('picker_modes_shots: the composer and each menu, light and dark, for the mockup comparison', async ({ app, core }) => {
  fakeAgents(core);
  start(core, 'claude', '--model', 'opus', '--effort', 'high');
  await openWindow(app);
  const out = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(out, { recursive: true });
  await expect.poll(() => drawn(app, 'model')).toBe('Opus');
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    const c = (await app.locator('.composer').boundingBox())!;
    await app.screenshot({ path: path.join(out, `picker-modes-chips-${scheme}.png`), clip: { x: c.x + c.width - 420, y: c.y + c.height - 50, width: 420, height: 50 } });
    for (const which of ['model', 'effort'] as const) {
      await chip(app, which).click();
      await expect(menu(app, which)).toBeVisible();
      if (which === 'model') await menu(app, 'model').locator('[data-item="more"]').click();
      const box = (await app.locator('.composer').boundingBox())!;
      await app.screenshot({ path: path.join(out, `picker-modes-${which}-${scheme}.png`), clip: { x: box.x + box.width - 760, y: box.y - 380, width: 760, height: box.height + 380 } });
      await app.keyboard.press('Escape');
      await app.mouse.click(5, 5);
    }
  }
});

test('picker_modes_ultracode_toggle_is_no_user_bubble: the picker\'s command reads as a quiet line, the same command typed by hand as a bubble', async ({ app, core }) => {
  // Ticket 1019 (look v24 h S3-2): every toggle added a user bubble. Claude records the picker's `/effort ultracode on` as a
  // typed command; it now reads as one quiet line. A command typed by hand stays the person's bubble.
  fakeAgents(core);
  const s = start(core, 'claude', '--model', 'opus') as { id: string; cwd: string; agent_session_id: string };
  const file = core.transcriptPath(s);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const user = (content: string) => JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content } }) + '\n';
  const command = (args: string) => user(`<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>${args}</command-args>`);
  const said = (text: string) => JSON.stringify({ type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
  // Round 2 (Fable review SHOULD 1): the same command typed by hand, before and after the toggle, stays a bubble.
  fs.writeFileSync(file, user('hello') + said('Hi.') + command('ultracode on'));
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  firstReply(core, s.id);
  const chat = app.locator(`.chat[data-session="${s.id}"]`);
  const typed = chat.locator('.msg.user').filter({ hasText: '/effort ultracode on' });
  await expect(typed).toHaveCount(1); // drawn before the toggle
  await chip(app, 'effort').click();
  await menu(app, 'effort').locator('[data-toggle="ultracode"]').click();
  await expect.poll(() => core.read(s.id)).toContain('SUBMIT:/effort ultracode on');
  fs.appendFileSync(file, command('ultracode on') + user('<local-command-stdout>Ultracode on (this session only)</local-command-stdout>') + command('ultracode on') + command('max'));
  await expect(chat.locator('.msg.user').filter({ hasText: '/effort max' })).toHaveCount(1);
  await expect(chat.locator('.msg.wake[data-control]')).toHaveText('/effort ultracode on');
  await expect(typed).toHaveCount(2); // the hand-typed one before and the one after the picker's
  await expect(chat.locator('.message-row.message-wake')).toHaveCount(1);
});

test('picker_modes_control_command_never_given_back: Stop does not put a slash command record back in the box', async () => {
  // W35-picker2 S2-2: Claude records `/effort ultracode on` as markup; sent again from the box it would be a prompt.
  // promptHistory's `recallable` (Stop's give-back and the box's history) returns '' for these.
  const { isCommandRecord } = await import('../src/chat/commandRecord');
  expect(isCommandRecord('<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode off</command-args>')).toBe(true);
  expect(isCommandRecord('  <command-name>/fast</command-name>')).toBe(true);
  expect(isCommandRecord('fix the bug')).toBe(false);
});
