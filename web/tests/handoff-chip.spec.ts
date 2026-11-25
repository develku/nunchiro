// V2-3b, window half: the composer picker's hand-off group, the chip (counts from `handoff.preview`, View/Edit, ✕,
// Esc) and the Enter that sends it, with fake agents (crates/nunchiro/tests/fixtures).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
function fakeAgents(core: Core) {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
}
const start = (core: Core, kind: string) => core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind).session as { id: string };
const reads = (core: Core, id: string) =>
  (fs.existsSync(path.join(core.home, `stdin-${id}.log`)) ? fs.readFileSync(path.join(core.home, `stdin-${id}.log`), 'utf8') : '').split('\n').filter((l) => l.startsWith('READ '));
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; kind: string; conversation?: string }[];
type Preview = { text: string; prompts: number; files: number; bytes: number };

/** Every request the window sends, and the last `handoff_preview` reply it got. */
function watch(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  const got: { preview: Preview | null } = { preview: null };
  app.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      const r = JSON.parse(f.payload).request;
      if (r) sent.push(r);
    });
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"type":"handoff"')) got.preview = JSON.parse(f.payload).response.Ok;
    });
  });
  return { sent, got, ops: (op: string) => sent.filter((r) => r.op === op) };
}

async function pick(app: Page, to: string) {
  await app.locator('[data-picker="model"]').click();
  const menu = app.locator('[data-menu="model"]');
  await menu.locator('[data-item="more"]').click(); // W35: the hand-off group is under More models ›
  await expect(menu.getByText('Hand off to another agent · starts on Enter')).toBeVisible();
  await menu.locator(`[data-item="handoff-${to}"]`).click();
}

test('handoff-chip: counts from the preview, Esc and ✕ cancel, nothing typed before Enter', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude');
  const w = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  const typed = reads(core, s.id).length;
  // The model group stays as it was (V1A-10); the hand-off group lists Codex with its model and account.
  await app.locator('[data-picker="model"]').click();
  await expect(app.locator('[data-menu="model"]').getByRole('menuitemradio')).toHaveCount(4); // W35 mockup 2: no Default row
  await app.locator('[data-menu="model"] [data-item="more"]').click();
  await expect(app.locator('[data-item="handoff-codex"]')).toHaveText('Codex · Default'); // B21 (ticket 991): no model named, so only the account reads Default
  await expect(app.locator('[data-item="manage"]')).toHaveText('Add or manage agents…');
  await app.keyboard.press('Escape'); // Esc closes one level: More models, then the menu
  await app.keyboard.press('Escape');

  await pick(app, 'codex');
  await expect.poll(() => w.got.preview).not.toBeNull();
  const p = w.got.preview!;
  const chip = app.locator('[data-handoff-chip]');
  await expect(chip).toHaveText(`Handoff from Claude · prompts ${p.prompts} · files ${p.files} · ${(p.bytes / 1024).toFixed(1)} KB`);
  await expect(app.getByRole('separator').filter({ hasText: 'Switching to Codex · handoff' })).toBeVisible();
  // Esc in the composer drops it.
  await app.locator('#composer').focus();
  await app.keyboard.press('Escape');
  await expect(chip).toHaveCount(0);
  // ✕ drops it too.
  await pick(app, 'codex');
  await expect(chip).toBeVisible();
  await app.getByRole('button', { name: 'Cancel handoff' }).click();
  await expect(chip).toHaveCount(0);
  // Choosing, browsing and cancelling started nothing and typed nothing.
  await app.waitForTimeout(300);
  expect(sessions(core)).toHaveLength(1);
  expect(reads(core, s.id)).toHaveLength(typed);
  expect(w.ops('handoff_send')).toHaveLength(0);
  expect(w.ops('handoff_preview')).toHaveLength(2);

  // The palette command "Hand off to Codex" does the same as the picker; Claude is not offered (the session's own).
  await app.getByRole('button', { name: 'Open command palette' }).click();
  const search = app.getByRole('combobox', { name: 'Command palette search' });
  const dialog = app.getByRole('dialog', { name: 'Command palette' });
  await search.fill('Hand off to');
  await expect(dialog.locator('[data-command="handoff.claude"]')).toHaveAttribute('aria-disabled', 'true');
  await search.fill('Hand off to Codex');
  await search.press('Enter');
  await expect(chip).toBeVisible();
  await expect.poll(() => w.ops('handoff_preview').length).toBe(3);
  expect(sessions(core)).toHaveLength(1);
});

test('handoff-chip: editable, Hangul composes, Enter while composing does not send, Enter sends one message', { tag: '@chromium' }, async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude');
  const w = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  const typed = reads(core, s.id).length;
  await pick(app, 'codex');
  await expect.poll(() => w.got.preview).not.toBeNull();
  const p = w.got.preview!;
  await app.getByRole('button', { name: 'View/Edit' }).click();
  const editor = app.getByRole('textbox', { name: 'Handoff text' });
  await expect(editor).toHaveValue(p.text);
  await editor.focus();
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  const cdp = await app.context().newCDPSession(app);
  await cdp.send('Input.insertText', { text: '메모: ' });
  for (const t of ['ㄴ', '누']) await cdp.send('Input.imeSetComposition', { text: t, selectionStart: 1, selectionEnd: 1 });
  // Enter while the IME still composes "누": the IME's key; nothing is sent.
  await app.keyboard.press('Enter');
  await app.waitForTimeout(300);
  expect(w.ops('handoff_send')).toHaveLength(0);
  await cdp.send('Input.insertText', { text: '눈' });
  // Chromium's synthetic Enter still adds its line break inside the textarea (a real IME keeps it); the syllable is whole.
  await expect.poll(() => editor.inputValue()).toMatch(/메모: 눈\n?$/);
  const edited = await editor.inputValue();
  expect(edited.startsWith(`${p.text}메모: 눈`)).toBe(true);
  expect(sessions(core)).toHaveLength(1);

  // Enter in the composer: one handoff_send with the edited text and the typed message.
  await app.locator('#composer').fill('계속해');
  await app.locator('#composer').press('Enter');
  await expect.poll(() => w.ops('handoff_send').length).toBe(1);
  expect(w.ops('handoff_send')[0]).toEqual({ op: 'handoff_send', from: s.id, to: 'codex', text: `${edited}\n\n계속해` });
  await expect(app.locator('[data-handoff-chip]')).toHaveCount(0);
  await expect.poll(() => sessions(core).length).toBe(2);
  const codex = sessions(core).find((x) => x.kind === 'codex')!;
  expect(codex.conversation).toBeTruthy();
  expect(sessions(core).find((x) => x.id === s.id)!.conversation).toBe(codex.conversation);
  // Codex got it as one message (its fixture acknowledges each line it reads); Claude got nothing.
  await expect.poll(() => core.read(codex.id)).toContain('ACK:계속해');
  expect(reads(core, s.id)).toHaveLength(typed);
  // The tab follows the conversation to Codex.
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveCount(1);
  // needs 130 round 3: no model on the new Codex session, so the chip names the agent alone ("Default" is the menu's row).
  await expect.poll(() => app.locator('[data-picker="model"]').getAttribute('aria-label')).toBe('Model: Codex');
});

test('handoff shots: picker group, chip, editor, chain after the switch', async ({ app, core }) => {
  fakeAgents(core);
  const s = start(core, 'claude');
  const w = watch(app);
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  const out = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(out, { recursive: true });
  const above = async (name: string, extra: number) => {
    const box = (await app.locator('.composer').boundingBox())!;
    await app.screenshot({ path: path.join(out, name), clip: { x: box.x, y: box.y - extra, width: box.width, height: box.height + extra } });
  };
  await app.locator('[data-picker="model"]').click();
  await app.locator('[data-menu="model"] [data-item="more"]').click();
  await above('handoff-picker-menu.png', 300);
  await app.keyboard.press('Escape');
  await app.keyboard.press('Escape');
  await pick(app, 'codex');
  await expect.poll(() => w.got.preview).not.toBeNull();
  await above('handoff-chip.png', 10);
  await app.getByRole('button', { name: 'View/Edit' }).click();
  await above('handoff-chip-edit.png', 10);
  await app.locator('#composer').fill('continue');
  await app.locator('#composer').press('Enter');
  await expect(app.getByRole('navigation', { name: 'Conversation' })).toBeVisible();
  await app.screenshot({ path: path.join(out, 'handoff-chain.png') });
});

test('handoff: a conversation tab shows its most urgent session; the chain ends with the one switched from', async () => {
  const { chain, tabStatus } = await import('../src/chat/conversation');
  const at = (id: string, kind: 'claude' | 'codex', last: number, extra: Record<string, unknown> = {}) =>
    ({ id, kind, conversation: 'c', state: 'running', pending: [], attention: { working: false, waiting: false, stale: false, failed: false, last_activity: last }, ...extra }) as never;
  const old = at('a', 'claude', 1, { attention: { working: true, waiting: false, stale: false, failed: false, last_activity: 1 } });
  const from = at('b', 'claude', 5);
  const now = at('c', 'codex', 9);
  expect(chain(now, [from, now, old]).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  expect(tabStatus(chain(now, [old, from, now]))).toBe('working');
  expect(tabStatus([now])).toBe('idle');
});
