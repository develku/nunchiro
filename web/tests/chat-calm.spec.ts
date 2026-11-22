// v25-chat-calm (ticket 158, V2.5-28; needs 144): the key hint only while a message waits, Language in Appearance, the
// chat width bar. A real core and a fake Claude; "working" is the real hook event over the owner socket.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';
import { openSettings } from './settings-modal';

const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}
function fakeClaude(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
}
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const hint = (app: Page) => app.locator('.composer .chint[aria-label="Composer keys"]');

test('hint_hidden_by_default: no key hint with an empty queue, idle or working', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'calm', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  await expect(app.locator('.composer textarea')).toBeVisible();
  await expect(hint(app)).toHaveCount(0);
  hook(core, s.id, 'UserPromptSubmit');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  await expect(app.locator('.composer .qlist')).toHaveCount(0);
  await expect(hint(app)).toHaveCount(0);
});

test('hint_shown_when_queued: the hint shows while a message waits and leaves after the turn', async ({ app, core }) => {
  fakeClaude(core);
  const s = core.agent(core.project('p'), 'calm', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  hook(core, s.id, 'UserPromptSubmit');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  const ta = app.locator('.composer textarea');
  await ta.fill('one more thing');
  await ta.press('Enter');
  await expect(app.locator('.composer .qlist')).toBeVisible();
  await expect(hint(app)).toBeVisible();
  await expect(hint(app)).toContainText('Esc stop');
  expect(await hint(app).evaluate((el) => getComputedStyle(el).fontSize)).toBe('11.5px'); // claude-feel-2 .hint (was pinned in design-chat)
  hook(core, s.id, 'Stop');
  await expect(app.locator('.composer .qlist')).toHaveCount(0);
  await expect(hint(app)).toHaveCount(0);
});

test('language_click_select: Settings shows Language on its first page (General), one pick switches the UI', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click(); // click 1: General is the first page (v25-fix-settings, finding 22)
  await expect(nav(app).getByRole('button', { name: 'Language' })).toHaveCount(0); // no page of its own
  const pick = app.getByRole('combobox', { name: /Language/ });
  await expect(pick).toHaveValue('system');
  await pick.selectOption('ko'); // click 2
  await expect(app.getByRole('navigation', { name: '설정 페이지' }).getByRole('button', { name: '화면과 테마', exact: true })).toBeVisible();
  await expect(app.getByRole('combobox', { name: /언어/ })).toHaveValue('ko');
});

test('chat_width_setting_survives_reload: the bar sets --chat-w and reload keeps it (widths measured in chat-calm-width.spec.ts)', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Appearance' }).click(); // v25-fix-settings: Settings opens on General
  const bar = app.getByRole('spinbutton', { name: 'Chat width' }) /* needs 192 (ticket 250 r3): a stepper */;
  await expect(bar).toHaveValue('100');
  await bar.fill('140');
  await expect(app.getByRole('spinbutton', { name: 'Chat width' })).toHaveValue('140'); // needs 192 (ticket 250 r3): the stepper shows the value
  const px = () => app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chat-w').trim());
  expect(await px()).toBe('980px');
  await app.reload();
  await openSettings(app); // not the chord (ticket 106), and not the gear alone: a reload keeps the modal open
  await expect(app.getByRole('spinbutton', { name: 'Chat width' }) /* needs 192 (ticket 250 r3): a stepper */).toHaveValue('140');
  expect(await px()).toBe('980px');
});
