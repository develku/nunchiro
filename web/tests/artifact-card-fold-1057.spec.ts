// Ticket 1057, 1088: one artifact file written three times draws three one-line cards (1088: the newest is a line by
// default too); the newest card's chevron shows the frame and folds it back to one line. Same real-core harness as artifacts.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { installHost } from './fixtures/artifacts/cards/host';
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

const page1 = (title: string, body = '<p>hello</p>') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** Writes the file into the session folder and the agent's Write call and result for it. */
function written(s: { cwd: string; file: string }, id: string, rel: string, content: string | Buffer, opts: { error?: boolean; at?: string; record?: string } = {}) {
  const full = opts.at ?? path.join(s.cwd, rel);
  if (!opts.error && !opts.at) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const text = opts.record ?? (typeof content === 'string' ? content : '');
  return [
    rec.use(id, 'Write', { file_path: full, content: text }),
    opts.error
      ? rec.result(id, 'Error: permission denied', { toolUseResult: 'Error: permission denied' }, true)
      : rec.result(id, `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: text, structuredPatch: [] } }),
  ];
}

const card = (page: Page, session: string, rel: string) => chat(page, session).locator(`.acard[data-path="${rel}"]`);

test('artifact_card_newest_frames_and_folds', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('go'), written(s, 'w1', 'report.html', page1('Report', '<p>v1</p>')), written(s, 'w2', 'report.html', page1('Report', '<p>v2</p>')), written(s, 'w3', 'report.html', page1('Report', '<p>v3</p>')));
  await openChat(page, s.id);
  const cards = card(page, s.id, 'report.html');
  await expect(cards).toHaveCount(3);
  await expect(chat(page, s.id).locator('.acard.line[data-path="report.html"]')).toHaveCount(3);
  await chat(page, s.id).getByRole('button', { name: 'Show the preview' }).click();
  await expect(cards.locator('xpath=self::*[contains(@class,"frame")]')).toHaveCount(1);
  await expect(chat(page, s.id).locator('.acard.line[data-path="report.html"]')).toHaveCount(2);
  const fold = chat(page, s.id).getByRole('button', { name: 'Fold the preview' });
  await fold.focus();
  await expect(fold).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chat(page, s.id).locator('.acard.frame')).toHaveCount(0);
  await expect(chat(page, s.id).locator('.acard.line[data-path="report.html"]')).toHaveCount(3);
  await chat(page, s.id).getByRole('button', { name: 'Show the preview' }).click();
  await expect(chat(page, s.id).locator('.acard.frame')).toHaveCount(1);
});
