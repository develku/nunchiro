// needs 171, 172 (chat basics, ticket 198): hover text on cut labels, the drafts popover's Esc and outside click, the
// composer image chip's preview, Artifacts paths, side-pane tab arrows and the message Copy label. A real core and a
// fake Claude (the chat harness); deterministic, no timers beyond the tooltip's own 300 ms.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { en, es, fr, ja, ko, pt, zhHans, zhHant } from '../src/i18n/areas/chat-base';
import { newShell } from './agent-pane';
import { icon } from './d5b';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import { patchSnapshots } from './visual/compare';

const tip = (page: Page) => page.locator('#app-tip');
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** Verbose shows every call as it came (Normal folds them into one summary). */
async function verbose(page: Page, id: string) {
  const cycle = chat(page, id).locator('.cview button');
  for (let i = 0; i < 4 && !/Verbose/.test((await cycle.getAttribute('aria-label')) ?? ''); i++) await cycle.click();
  await expect(cycle).toHaveAttribute('aria-label', /Verbose/);
}

test('tool_row_label_tooltip: a cut tool row label shows its full text on hover; a Read shows the full path; an uncut label shows none', async ({ page, chatCore }) => {
  const s = chatCore.chat('tl');
  const command = `echo ${'long-argument-'.repeat(20)}end`;
  append(
    s.file,
    rec.user('go'),
    rec.use('b1', 'Bash', { command }),
    rec.result('b1', 'ok'),
    rec.use('r1', 'Read', { file_path: '/opt/elsewhere/deep/er/dir/notes.txt' }),
    rec.result('r1', 'text'),
    rec.use('b2', 'Bash', { command: 'echo hi' }),
    rec.result('b2', 'hi'),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  await verbose(page, s.id);
  const view = chat(page, s.id);
  // A cut label: the whole command.
  const cut = view.locator('.tool .tl', { hasText: 'Ran echo long-argument-' });
  expect(await cut.evaluate((e) => [e, ...e.querySelectorAll('*')].some((x) => x.scrollWidth > x.clientWidth))).toBe(true);
  await cut.hover();
  await expect(tip(page)).toBeVisible();
  await expect(tip(page)).toHaveText(`Ran ${command}`);
  // A Read shows the base name; its tooltip holds the full path.
  const read = view.locator('.tool .tl', { hasText: 'Read notes.txt' });
  await read.hover();
  await expect(tip(page)).toContainText('/opt/elsewhere/deep/er/dir/notes.txt');
  // An uncut label has nothing more to say.
  await page.mouse.move(5, 5);
  await expect(tip(page)).toBeHidden();
  await view.locator('.tool .tl', { hasText: 'Ran echo hi' }).hover();
  await page.waitForTimeout(600);
  await expect(tip(page)).toBeHidden();
});

test('decision_line_tooltip: a long pending question leaves no line (and no tooltip) in the chat; the Decisions widget holds it (needs 205)', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Need to run it.'));
  await page.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ strip: 'off' })));
  const question = `Bash: ${'pnpm install --frozen-lockfile && '.repeat(8)}pnpm build`;
  await patchSnapshots(page, { asks: { waiting: 'permission', text: question } });
  await openChat(page, s.id);
  await expect(chat(page, s.id).locator('.dline')).toHaveCount(0);
  await expect(chat(page, s.id).locator('[data-tip*="pnpm install --frozen-lockfile"]')).toHaveCount(0);
});

const composer = (page: Page) => page.locator('.cbox:visible').first();
const drafts = (page: Page, _id: string) => composer(page).getByRole('button', { name: /^Saved drafts \(\d+\)$/ });
const popover = (page: Page, _id: string) => composer(page).getByRole('group', { name: 'Saved drafts' });

test('drafts_popover_closes: opened with the mouse, Esc (focus elsewhere) and a click outside each close it and focus returns to the drafts button', async ({ page, chatCore }) => {
  const s = chatCore.chat('drafts');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  // Esc, with focus not inside the popover.
  await drafts(page, s.id).click();
  await expect(popover(page, s.id)).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(popover(page, s.id)).toHaveCount(0);
  await expect(drafts(page, s.id)).toBeFocused();
  // A click outside, on text that takes no focus.
  await drafts(page, s.id).click();
  await expect(popover(page, s.id)).toBeVisible();
  await chat(page, s.id).locator('.message-row').first().click({ position: { x: 4, y: 4 } });
  await expect(popover(page, s.id)).toHaveCount(0);
  await expect(drafts(page, s.id)).toBeFocused();
  // The in-popover case still works: focus on the button, Esc closes and keeps focus there.
  await drafts(page, s.id).click();
  await expect(popover(page, s.id)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover(page, s.id)).toHaveCount(0);
  await expect(drafts(page, s.id)).toBeFocused();
});

test('drafts_popover_closes (outside click on a field): the popover closes and the field the user clicked keeps focus', async ({ page, chatCore }) => {
  const s = chatCore.chat('drafts2');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  await drafts(page, s.id).click();
  await expect(popover(page, s.id)).toBeVisible();
  const box = composer(page).locator('textarea:not(.hoff-edit)');
  await box.click();
  await expect(popover(page, s.id)).toHaveCount(0);
  await expect(box).toBeFocused();
});

const chipOf = (page: Page, _id: string) => composer(page).locator('.ichip');
const viewer = (page: Page, name: string) => page.getByRole('dialog', { name: `Image ${name}` });
async function attach(page: Page, id: string) {
  await composer(page).locator('input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
  await expect(chipOf(page, id)).toHaveCount(1);
}

test('esc_in_overlay_keeps_popover: Esc in an image viewer opened over the composer closes only the viewer; the next Esc closes the popover and focus returns to the drafts button', async ({ page, chatCore }) => {
  const s = chatCore.chat('escov');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  await attach(page, s.id);
  await drafts(page, s.id).click();
  await expect(popover(page, s.id)).toBeVisible();
  // Focus off the popover (a viewer taking focus from inside it would close it by blur, which is not this case); a script click opens the viewer without a pointerdown.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await chipOf(page, s.id).getByRole('button', { name: 'Open image p.png' }).evaluate((b) => (b as HTMLElement).click());
  await expect(viewer(page, 'p.png')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page, 'p.png')).toHaveCount(0);
  await expect(popover(page, s.id)).toBeVisible();
  // The viewer gives focus back to its thumbnail one frame after it closes (Thumbnail.tsx); a second Esc before that would
  // be followed by the late focus and leave it off the drafts button, so wait for the viewer to finish.
  await expect(chipOf(page, s.id).getByRole('button', { name: 'Open image p.png' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover(page, s.id)).toHaveCount(0);
  await expect(drafts(page, s.id)).toBeFocused();
});

test('image_chip_preview: a click on a composer image chip (thumbnail or name) opens the viewer; Enter and Space on the thumbnail too; Remove still removes without opening it', async ({ page, chatCore }) => {
  const s = chatCore.chat('chip');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  await attach(page, s.id);
  const chip = chipOf(page, s.id);
  // The thumbnail.
  const thumb = chip.getByRole('button', { name: 'Open image p.png' });
  await thumb.click();
  await expect(viewer(page, 'p.png')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page, 'p.png')).toHaveCount(0);
  // The name.
  await chip.locator('.iname').click();
  await expect(viewer(page, 'p.png')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page, 'p.png')).toHaveCount(0);
  // The keyboard, on the focusable thumbnail.
  for (const key of ['Enter', 'Space']) {
    await thumb.focus();
    await page.keyboard.press(key);
    await expect(viewer(page, 'p.png')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer(page, 'p.png')).toHaveCount(0);
  }
  // Remove removes and opens nothing.
  await chip.getByRole('button', { name: 'Remove image p.png' }).click();
  await expect(chipOf(page, s.id)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('changed_file_path_tooltip (Artifacts): a cut changed-file path shows the full path on hover', async ({ page, chatCore }) => {
  const dir = chatCore.project('aw');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...a], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const long = `${'quite-long-directory-name/'.repeat(6)}deep-file-name.ts`;
  fs.mkdirSync(path.join(dir, path.dirname(long)), { recursive: true });
  fs.writeFileSync(path.join(dir, long), 'x\n');
  const s = chatCore.chat('aw');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Artifacts' });
  const name = dock.getByRole('list', { name: 'Files changed' }).locator(`[data-path="${long}"] .awn`);
  await expect(name).toBeVisible();
  expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await name.hover();
  await expect(tip(page)).toHaveText(long);
});

test('side_pane_tabs_arrows: Left, Right, Home and End move between the side-pane tabs with wrap, and select', async ({ page, chatCore }) => {
  const s = chatCore.chat('tabs');
  append(s.file, rec.user('go'), rec.assistant('ok'));
  await openChat(page, s.id);
  await icon(page, 'right', 'Terminal').click();
  const pane = page.locator('[data-side-pane]:not([hidden])');
  await expect(pane).toBeVisible();
  // v25-shell-chrome (ticket 284 item 4): the Views tablist (Browser, Preview) left with the pane's top strip; both open from their own icon and command.
  await expect(pane.getByRole('tablist', { name: 'Views' })).toHaveCount(0);
  // The Terminals tablist: the session's PTY and a new shell. Arrows stay inside their own list.
  await newShell(page);
  const terminals = pane.getByRole('tablist', { name: 'Terminals' }).getByRole('tab');
  await expect(terminals).toHaveCount(2);
  await terminals.first().click();
  await expect(terminals.first()).toHaveAttribute('aria-selected', 'true');
  await terminals.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(terminals.nth(1)).toBeFocused();
  await expect(terminals.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(terminals.first()).toBeFocused();
  await expect(terminals.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(terminals.nth(1)).toBeFocused();
});

test('copy_message_label: the message Copy button keeps the text "Copy" and is named "Copy message" ("Copied" after); the code-block Copy is unchanged; the key exists in all eight languages', async ({ page, chatCore }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: string[] };
    w.__clip = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void w.__clip.push(t) } });
  });
  const s = chatCore.chat('copylabel');
  append(s.file, rec.user('hello'), rec.assistant('```ts\nconst a = 1;\n```'));
  await openChat(page, s.id);
  const row = chat(page, s.id).locator('.message-row').first();
  await row.hover();
  const copy = row.locator('.message-actions').getByRole('button', { name: 'Copy message', exact: true });
  await expect(copy).toHaveText('Copy');
  await copy.click();
  await expect(row.locator('.message-actions').getByRole('button', { name: 'Copied', exact: true })).toHaveText('Copied');
  // The code block's own Copy keeps its name.
  await expect(chat(page, s.id).locator('.codeblk').getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  // One key, eight languages, each a non-empty string.
  const all = { en, ko, ja, zhHans, zhHant, es, fr, pt } as Record<string, Record<string, string>>;
  for (const [lang, table] of Object.entries(all)) expect(table['chat.row.copyMessage'], lang).toBeTruthy();
  expect((en as Record<string, string>)['chat.row.copyMessage']).toBe('Copy message');
});

test('steer_label (Q7 point 16): a message that went in as a steer says so on its bubble; a plain one does not', async ({ page, chatCore }) => {
  const s = chatCore.chat('steer');
  // What the composer's send-now path records when the core accepts the steer (queued.ts noteSteer).
  await page.addInitScript((id) => localStorage.setItem('nunchiro.composer.steers.v1', JSON.stringify({ [id]: ['stop, do the tests first'] })), s.id);
  append(s.file, rec.user('write the parser'), rec.assistant('working on it'), rec.user('stop, do the tests first'));
  await openChat(page, s.id);
  const bubbles = chat(page, s.id).locator('.msg.user');
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.nth(0).locator('.steer-tag')).toHaveCount(0);
  await expect(bubbles.nth(1).locator('.steer-tag')).toHaveText('Steer');
});

test('blockquote_gap_before_code (look v34 S3-2): a code block after a blockquote, or after a paragraph, keeps the normal 8 px block gap', async ({ page, chatCore }) => {
  const s = chatCore.chat('bqgap');
  append(s.file, rec.user('hello'), rec.assistant('> a quote\n\n```sh\nls\n```\n\nplain\n\n```sh\npwd\n```'));
  await openChat(page, s.id);
  const md = chat(page, s.id).locator('.md').last();
  await expect(md.locator('.codeblk')).toHaveCount(2);
  const gaps = await md.evaluate((el) =>
    [...el.querySelectorAll(':scope > .codeblk')].map((c) => Math.round(c.getBoundingClientRect().top - (c.previousElementSibling as Element).getBoundingClientRect().bottom)),
  );
  expect(gaps).toEqual([8, 8]);
});
