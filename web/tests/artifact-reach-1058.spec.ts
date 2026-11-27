// Ticket 1058: the side pane's Preview closes (button and Escape, focus back to the composer), and the Artifacts widget
// lists an artifact written before the newest chat page (a page is 2 MB).
import type { Page } from '@playwright/test';
import { installHost } from './fixtures/artifacts/cards/host';
import { gitChat, page1, written } from './fixtures/artifacts-widget/helpers';
import { append, openChat, rec, test as chatTest, expect } from './fixtures/chat/harness';
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
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
    { auto: true },
  ],
});

const dock = (page: Page) => page.getByRole('complementary', { name: 'Artifacts' });
const rows = (page: Page) => dock(page).getByRole('list', { name: 'This session' }).getByRole('listitem');
const openWidget = async (page: Page) => {
  if (!(await dock(page).isVisible())) await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
};
const close = (page: Page) => page.locator('.preview .pv-top').getByRole('button', { name: 'Close Preview' });
const composer = (page: Page) => page.locator('.composer textarea:not(.hoff-edit)');

test('the Preview in the side pane closes by its button and by Escape, and focus goes back', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'close-1058', null);
  append(s.file, written(s, 'w1', 'a.html', page1('Report')));
  await openChat(page, s.id);
  await openWidget(page);
  await rows(page).first().locator('button.it').click();
  await expect(page.locator('.preview .pv-frame')).toBeVisible();
  await close(page).click();
  await expect(page.locator('.preview')).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  await openWidget(page);
  await rows(page).first().locator('button.it').click();
  await close(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.preview')).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
});

test('the widget lists an artifact on an older chat page, and its row opens the Preview', async ({ page, chatCore }) => {
  const s = gitChat(chatCore, 'older-1058', null);
  append(s.file, written(s, 'w1', 'old.html', page1('Old report')));
  // Over a page (2 MiB, chat/log.rs PAGE_BYTES) of later records pushes it to an older page. As command output, which the
  // chat shows folded: 4 MB of open assistant text took WebKit 15 to 30 s to draw, past the first page's wait.
  for (let i = 0; i < 4; i++) append(s.file, rec.use(`b${i}`, 'Bash', { command: `cat log-${i}` }), rec.result(`b${i}`, `${i} ${'x'.repeat(1_000_000)}`));
  await openChat(page, s.id);
  await expect(page.locator(`.chat[data-session="${s.id}"] .acard`), 'the write is on an older page, not the one shown').toHaveCount(0);
  await openWidget(page);
  await expect(rows(page)).toHaveText([/Old report.*by agent/]);
  await rows(page).first().locator('button.it').click();
  await expect(page.locator('.preview .pv-frame')).toBeVisible();
});
