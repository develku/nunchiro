// Ticket 1086: a Markdown or image file the turn wrote shows once, as its row in the changed-files card, with Open before
// its numbers; no separate one-line card. HTML keeps its framed card; a document outside the changed files keeps its card.
// Same real-core harness as artifacts.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { installHost, showFrame } from './fixtures/artifacts/cards/host';
import { append, chat, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';

type Art = Awaited<ReturnType<typeof artifactServer>>;
const test = chatTest.extend<{ host: { opened: string[] } }, { art: Art }>({
  art: [
    async ({}, use) => {
      const art = await artifactServer({});
      await use(art);
      await art.close();
    },
    { scope: 'worker' },
  ],
  host: [
    async ({ page, art }, use) => {
      const opened: string[] = [];
      await installHost(page, art, opened);
      await use({ opened });
    },
    { auto: true },
  ],
});

/** Writes the file into the session folder and the agent's Write call and result for it. */
function written(s: { cwd: string }, id: string, rel: string, content: string) {
  const full = path.join(s.cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return [
    rec.use(id, 'Write', { file_path: full, content }),
    rec.result(id, `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content, structuredPatch: [] } }),
  ];
}

const MD = '# Review\n\none\ntwo\nthree\nfour\nfive\n'; // 7 lines
const card = (page: Page, id: string) => chat(page, id).locator('.chcard');
const row = (page: Page, id: string, rel: string) => card(page, id).locator('li').filter({ has: page.locator(`.frow[data-path$="${rel}"]`) });

test('file_card_one_document_is_one_row', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('go'), written(s, 'w1', 'docs/review.md', MD), rec.assistant('done'), rec.end());
  await openChat(page, s.id);
  await expect(card(page, s.id)).toHaveCount(1);
  await expect(chat(page, s.id).locator('.acard')).toHaveCount(0);
  const r = row(page, s.id, 'docs/review.md');
  await expect(r).toContainText('docs/review.md');
  await expect(r).toContainText('+7');
  await expect(r).toContainText('−0');
  await expect(r.getByRole('button', { name: 'Open' })).toBeVisible();
  // Left to right: path, Open, numbers, View in Diff.
  const xs = await Promise.all(
    [r.locator('.frow .p'), r.getByRole('button', { name: 'Open' }), r.locator('.add'), card(page, s.id).getByRole('button', { name: 'View in Diff' })].map(async (l) => (await l.boundingBox())!.x),
  );
  expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  // One line: every control on the same row.
  const ys = await Promise.all([r.getByRole('button', { name: 'Open' }), card(page, s.id).getByRole('button', { name: 'View in Diff' })].map(async (l) => (await l.boundingBox())!));
  expect(Math.abs(ys[0].y + ys[0].height / 2 - (ys[1].y + ys[1].height / 2))).toBeLessThan(4);
});

test('file_card_open_opens_preview_and_tab_order', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('go'), written(s, 'w1', 'docs/review.md', MD), rec.assistant('done'), rec.end());
  await openChat(page, s.id);
  const r = row(page, s.id, 'docs/review.md');
  const open = r.getByRole('button', { name: 'Open' });
  const view = card(page, s.id).getByRole('button', { name: 'View in Diff' });
  // WebKit's Tab skips buttons unless the system "keyboard navigation" switch is on; Option+Tab reaches every control.
  const alt = page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+' : '';
  await r.locator('.frow').focus();
  await page.keyboard.press(`${alt}Tab`);
  await expect(open).toBeFocused();
  await page.keyboard.press(`${alt}Tab`);
  await expect(view).toBeFocused();
  await page.keyboard.press(`Shift+${alt}Tab`);
  await page.keyboard.press('Enter');
  await expect(page.locator('.preview .pv-body h1')).toHaveText('Review');
});

test('file_card_several_files_one_document_has_open', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('go'), written(s, 'a', 'a.txt', 'a\n'), written(s, 'b', 'notes.md', MD), written(s, 'c', 'c.txt', 'c\n'), rec.assistant('done'), rec.end());
  await openChat(page, s.id);
  await expect(card(page, s.id)).toHaveCount(1);
  await expect(card(page, s.id).locator('.frow')).toHaveCount(3);
  await expect(card(page, s.id).getByRole('button', { name: 'Open' })).toHaveCount(1);
  await expect(row(page, s.id, 'notes.md').getByRole('button', { name: 'Open' })).toHaveCount(1);
  await expect(chat(page, s.id).locator('.acard')).toHaveCount(0);
});

test('file_card_written_twice_is_one_row', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('go'), written(s, 'w1', 'notes.md', '# One\n'), written(s, 'w2', 'notes.md', MD), rec.assistant('done'), rec.end());
  await openChat(page, s.id);
  await expect(card(page, s.id).locator('.frow')).toHaveCount(1);
  await expect(card(page, s.id).getByRole('button', { name: 'Open' })).toHaveCount(1);
  await expect(chat(page, s.id).locator('.acard')).toHaveCount(0);
});

test('file_card_html_keeps_frame_and_block_keeps_card', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  const html = '<!doctype html><html><head><title>Page</title></head><body><p>hi</p></body></html>';
  append(
    s.file,
    rec.user('go'),
    written(s, 'h1', 'page.html', html),
    rec.assistant('Notes:\n\n\`\`\`nunchiro-artifact md\n# Block notes\n\`\`\`\n'),
  );
  await openChat(page, s.id);
  // Ticket 1088: the HTML card is one line by default; its chevron shows the frame.
  await expect(chat(page, s.id).locator('.acard[data-path="page.html"]')).toHaveCount(1);
  await expect(row(page, s.id, 'page.html').getByRole('button', { name: 'Open' })).toHaveCount(0);
  // A document that is not in the changed files (an artifact block) keeps its own one-line card.
  await expect(chat(page, s.id).locator('.acard.line .at')).toHaveText(['Page', 'Block notes']);
  await showFrame(chat(page, s.id).locator('.acard[data-path="page.html"]'));
  await expect(chat(page, s.id).locator('.acard.frame[data-path="page.html"]')).toHaveCount(1);
});
