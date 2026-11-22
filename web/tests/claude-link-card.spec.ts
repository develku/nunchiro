// Needs 117 / ticket 73: a claude.ai published-artifact link in chat shows a card that only opens it in the user's browser.
// Real core, fake agent (like md-images.spec.ts).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const OPEN = { name: 'Open in browser' };

/** Records window.open calls instead of opening a tab, and every outgoing request URL. */
const spy = async (page: Page) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[][] };
    w.__opened = [];
    window.open = ((...a: unknown[]) => (w.__opened.push(a), null)) as typeof window.open;
  });
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  return requests;
};
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);

test('link_in_assistant_text_becomes_card: plain, code-shaped and Markdown links each give one card', async ({ page, chatCore }) => {
  await spy(page);
  const s = chatCore.chat();
  append(
    s.file,
    rec.assistant('Published: https://claude.ai/artifact/abc123XYZ'),
    rec.assistant(`Code: https://claude.ai/code/artifact/${UUID}`),
    rec.assistant('Md: [page](https://claude.ai/artifact/mdLink1)'),
    rec.assistant('done'),
  );
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  await expect(view.getByRole('button', OPEN)).toHaveCount(3);
  await expect(view.locator('.acard.line[data-claude-link="https://claude.ai/artifact/abc123XYZ"]')).toHaveCount(1);
  await expect(view.locator(`.acard.line[data-claude-link="https://claude.ai/code/artifact/${UUID}"]`)).toHaveCount(1);
  // The Markdown link still works as before, through Link.
  await view.getByRole('link', { name: 'page' }).click();
  expect((await opened(page)).at(-1)?.[0]).toBe('https://claude.ai/artifact/mdLink1');
});

test('link_in_tool_result_becomes_card: under the tool body once the row is open', async ({ page, chatCore }) => {
  await spy(page);
  // Verbose: the default Normal view folds the tool call into a summary line (chat/view.ts, needs 166).
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  const s = chatCore.chat();
  append(s.file, rec.use('t1', 'Artifact', { file_path: 'a.html' }), rec.result('t1', 'Published https://claude.ai/artifact/tool1'), rec.assistant('done'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  await expect(view.getByRole('button', OPEN)).toHaveCount(0);
  await view.locator('button.tl').first().click();
  await expect(view.getByRole('button', OPEN)).toHaveCount(1);
});

test('lookalikes_stay_text: no card, text unchanged; duplicate gives one card, six give five', async ({ page, chatCore }) => {
  await spy(page);
  const s = chatCore.chat();
  const bad = ['https://claude.ai.evil.com/artifact/x', 'https://claude.ai@evil.com/artifact/x', 'http://claude.ai/artifact/x', 'https://claude.ai:8443/artifact/x', `https://claude.ai/chat/${UUID}`, 'https://claude.ai/artifact/x/../../chat/y'];
  append(s.file, rec.assistant(bad.join('\n\n')), rec.assistant('done'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  await expect(view.getByRole('button', OPEN)).toHaveCount(0);
  for (const b of bad) await expect(view.locator('.md').first()).toContainText(b);
  const s2 = chatCore.chat('two', true, false, 'chat'); // ticket 570: in s's project, so its tab is in the strip
  const six = 'abcdef'.split('').map((c) => `https://claude.ai/artifact/${c}`);
  append(s2.file, rec.assistant(`${six[0]} ${six[0]}`), rec.assistant(six.join(' ')), rec.assistant('end'));
  await openChat(page, s2.id);
  const v2 = chat(page, s2.id);
  await expect(v2.getByText('end')).toBeVisible();
  await expect(v2.getByRole('button', OPEN)).toHaveCount(1 + 5);
});

test('click_opens_via_external_path: the rebuilt URL, noopener, nothing navigates or frames', async ({ page, chatCore }) => {
  await spy(page);
  const s = chatCore.chat();
  append(s.file, rec.assistant('Here https://claude.ai/artifact/q1?token=secret#frag now'), rec.assistant('done'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  const url = page.url();
  const frames = page.frames().length;
  const iframes = await page.locator('iframe').count();
  await view.getByRole('button', OPEN).click();
  await expect.poll(() => opened(page)).toEqual([['https://claude.ai/artifact/q1', '_blank', 'noopener']]);
  expect(page.url()).toBe(url);
  expect(page.frames().length).toBe(frames);
  expect(await page.locator('iframe').count()).toBe(iframes);
});

test('no_load_inside_nunchiro: no request to claude.ai, no card media; reachable_in_at_most_2_clicks', async ({ page, chatCore }) => {
  const requests = await spy(page);
  const s = chatCore.chat();
  append(s.file, rec.assistant('https://claude.ai/artifact/q1'), rec.assistant('done'));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('done')).toBeVisible();
  const card = view.locator('.acard.line');
  await expect(card).toBeVisible();
  await expect(card.locator('iframe, img, video, object, embed')).toHaveCount(0);
  await expect(card).toHaveAttribute('title', 'https://claude.ai/artifact/q1');
  await view.getByRole('button', OPEN).click(); // one click from the open chat (two from the tree: tab click in openChat)
  expect(requests.filter((u) => new URL(u).hostname.endsWith('claude.ai'))).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`keyboard_and_axe (${scheme}): Tab, Enter and Space open; axe clean`, async ({ page, chatCore, browserName }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await spy(page);
    const s = chatCore.chat();
    append(s.file, rec.assistant('https://claude.ai/artifact/k1'), rec.assistant('done'));
    await openChat(page, s.id);
    const view = chat(page, s.id);
    await expect(view.getByText('done')).toBeVisible();
    const btn = view.getByRole('button', OPEN);
    // WebKit's Tab skips buttons unless Full Keyboard Access is on, so there the button is focused directly (it is a native, tabindex 0 button).
    if (browserName === 'webkit') await btn.focus();
    else for (let i = 0; i < 40 && !(await btn.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(btn).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await opened(page)).length).toBe(2);
    const r = await new AxeBuilder({ page }).include('.acard.line').analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });
}

test('side_by_side_page: local line card, the claude.ai card and look-alike text in one chat, light and dark', async ({ page, chatCore }) => {
  await spy(page);
  const s = chatCore.chat();
  append(
    s.file,
    rec.use('w1', 'Write', { file_path: path.join(s.cwd, 'notes.md'), content: '# Notes' }),
    rec.result('w1', 'File created successfully'),
    rec.assistant('Local file card above.'),
    rec.assistant(`Published: https://claude.ai/artifact/abc123XYZ and https://claude.ai/code/artifact/${UUID}`),
    rec.assistant('Look-alikes: https://claude.ai.evil.com/artifact/x http://claude.ai/artifact/x https://claude.ai/chat/abc'),
    rec.assistant('done'),
  );
  fs.writeFileSync(path.join(s.cwd, 'notes.md'), '# Notes');
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('done')).toBeVisible();
  await expect(chat(page, s.id).locator('.acard.line')).toHaveCount(3);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await chat(page, s.id).locator('.clist').screenshot({ path: `../.scratch/claude-link/${scheme}.png` });
  }
});
