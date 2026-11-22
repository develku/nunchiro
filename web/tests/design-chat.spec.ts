// v25-design-chat (ticket 146, V2.5-25): the chat body and composer design pass. Each changed control is reached from
// its visible, labelled control (chat_controls_reachable); the working row is the real hook event over the owner socket.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { append, chat, type ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { mockupTurn } from './fixtures/fidelity-chat/turn';
import { patchSnapshots } from './visual/compare';

const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: ChatCore, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}

async function answered(page: Page, core: ChatCore) {
  const s = core.chat('design');
  append(s.file, rec.user('make the rows 30px'), rec.assistant('Done: rows are 30px.'));
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.md')).toContainText('rows are 30px');
  hook(core, s.id, 'Stop'); // the fake agent's start reads as a turn; end it so each test starts idle
  await expect(page.locator('.composer .send')).toHaveAccessibleName('Send');
  return s;
}

test('working_row_shows_while_working', async ({ page, chatCore }) => {
  const s = await answered(page, chatCore);
  const view = chat(page, s.id);
  await expect(view.locator('.wline')).toHaveCount(0);
  hook(chatCore, s.id, 'UserPromptSubmit');
  const line = view.locator('.wline');
  await expect(line).toBeVisible();
  await expect(view.locator('.wlive')).toHaveRole('status'); // the live region was there before the row
  await expect(line.locator('.wtime')).toHaveText(/^Working for \d+s$/);
  await expect(line.locator('.sr')).toHaveText('Working'); // what the live region announces, once
  await expect(line.locator('svg[data-icon="work"] .arc')).toHaveCount(1); // the tree's working arc (needs 92)
  await expect(line.getByRole('button')).toHaveCount(0); // Stop stays the composer's one control (needs 109)
  await expect(page.locator('.composer .send')).toHaveAccessibleName('Stop');
  hook(chatCore, s.id, 'Stop');
  await expect(line).toHaveCount(0);
  await expect(view.locator('.wlive')).toHaveCount(1); // the region stays, empty
  // The next turn counts from 0 again, not from the first turn's start.
  await page.clock.install();
  hook(chatCore, s.id, 'UserPromptSubmit');
  await expect(line.locator('.wtime')).toHaveText('Working');
  await page.clock.runFor(5_000);
  await expect(line.locator('.wtime')).toHaveText('Working for 5s');
});

test('working_row_counts_from_the_turn_start (q67 look, new 7): a chat drawn mid-turn shows the turn\'s own time, the one its tree row counts', async ({ page, chatCore }) => {
  const s = await answered(page, chatCore);
  hook(chatCore, s.id, 'UserPromptSubmit');
  await expect(chat(page, s.id).locator('.wline')).toBeVisible();
  await page.waitForTimeout(4_000);
  // A reload draws the list anew: it counted from 0 again ("Working"), while the row beside it said the turn's time.
  await page.reload();
  const time = chat(page, s.id).locator('.wline .wtime');
  await expect(time).toBeVisible();
  expect(Number(/(\d+)s$/.exec(await time.innerText())?.[1] ?? 0)).toBeGreaterThanOrEqual(4);
});

test('working_row_aligns_with_turn_summary', async ({ page, chatCore }) => {
  const s = chatCore.chat('layout-b');
  mockupTurn(s.file, s.cwd);
  await patchSnapshots(page, { 'layout-b': { working: true } });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.locator('.wline .wtime')).toBeVisible();
  const left = (sel: string) => view.locator(sel).first().evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return Math.round(r.getBoundingClientRect().left); // where the glyphs start, not the box
  });
  expect(await left('.wline .wtime')).toBe(await left('.sum .n')); // the label under the summary's label
  const box = async (sel: string) => (await view.locator(sel).first().boundingBox())!.x;
  expect(Math.abs((await box('.wline svg')) - (await box('.sum .c')))).toBeLessThanOrEqual(1); // the arc in the chevron's place
});

test('working_row_in_korean', async ({ page, chatCore }) => {
  const s = await answered(page, chatCore);
  await page.evaluate(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  await page.reload();
  await expect(chat(page, s.id).locator('.md')).toContainText('rows are 30px');
  await page.clock.install();
  hook(chatCore, s.id, 'UserPromptSubmit');
  await expect(chat(page, s.id).locator('.wline .wtime')).toHaveText('작업 중');
  await expect(chat(page, s.id).locator('.wline .sr')).toHaveText('작업 중');
  // Ticket 780 (walk 9): the time unit is the window's language too, not an English "s".
  await page.clock.runFor(65_000);
  await expect(chat(page, s.id).locator('.wline .wtime')).toHaveText('작업 중 1분 5초');
});

test('chat_controls_reachable: transcript view control', async ({ page, chatCore }) => {
  const s = await answered(page, chatCore);
  const control = chat(page, s.id).getByRole('button', { name: /^Transcript view/ });
  await expect(control).toBeVisible();
  await expect(control).toHaveText('Normal');
  await control.click();
  await expect(control).toHaveText('Thinking');
  // Quiet, but still drawn as a control on hover.
  await control.hover();
  await expect.poll(() => control.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('chat_controls_reachable: composer box on the chat background', async ({ page, chatCore }) => {
  const s = await answered(page, chatCore);
  const box = page.locator('.composer .cbox');
  const input = page.getByRole('combobox', { name: /^Message/ });
  await expect(input).toBeVisible();
  await input.click();
  await expect(input).toBeFocused();
  await input.fill('next');
  await expect(page.locator('.composer .send')).toBeEnabled();
  const bg = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await bg('.composer')).toBe(await bg(`.chat[data-session="${s.id}"]`)); // no band between pane and composer
  await page.mouse.click(5, 5);
  // Ticket 1041 (polish-1121 .comp): a tint step, no border and no shadow.
  await expect.poll(() => box.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await box.evaluate((el) => [getComputedStyle(el).boxShadow, getComputedStyle(el).borderTopWidth])).toEqual(['none', '0px']);
});

test('empty_state_hint_keeps_its_size', async ({ page, chatCore }) => {
  const s = chatCore.chat('fresh', false);
  await openChat(page, s.id);
  const block = chat(page, s.id).locator('.cscroll .empty');
  const size = (sel: string) => block.locator(sel).evaluate((el) => getComputedStyle(el).fontSize);
  await expect(page.locator('.composer .chint')).toHaveCount(0); // v25-chat-calm (needs 144): no key hint until a message waits
  expect(await size('.ehead p')).toBe('15px');
});
