// Spec v1b Acceptance 5 with a real agent: driven by scripts/scenario/v1b-images.sh, which starts the core and a
// Claude (or Codex) session and passes them in IMAGES_LIVE. The user pastes a generated image, types, presses Enter;
// the agent's own transcript must carry an image block and the chat user block must render it.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { windowAuth } from './fixtures';
import { frames, give, helpers, ptyWrites } from './fixtures/images/helpers';

type Live = { home: string; session: string; agent: string; png: string; prompt: string; out: string };
const live = process.env.IMAGES_LIVE ? (JSON.parse(process.env.IMAGES_LIVE) as Live) : null;

test('scenario: a pasted image is sent as a saved path and comes back as a chat thumbnail from the transcript', { tag: '@live' }, async ({ page }) => {
  test.setTimeout(240_000);
  const L = live!;
  const boot = windowAuth(L.home);
  await page.addInitScript((b) => (window.__NUNCHIRO__ = b), boot);
  await page.addInitScript(helpers);
  await page.goto('/');
  await page.locator(`.tab[data-tab="${L.session}"]`).click();
  const box = page.locator('.cbox textarea');
  await expect(box).toBeEnabled();
  await box.focus();
  // xterm answers the agent's terminal queries on load; only what follows the paste is the composer's.
  await page.waitForTimeout(1500);
  const mark = await page.evaluate(() => performance.now());
  const after = async () => (await ptyWrites(page)).filter((f) => f.at > mark);
  await give(page, [{ bytes: [...Buffer.from(L.png, 'base64')], name: 'fixture.png', type: 'image/png' }]);
  await expect(page.locator('.cbox .ichip')).toHaveCount(1);
  await page.screenshot({ path: `${L.out}.composer.png` });
  // Nothing reaches the PTY before the user's Enter.
  expect(await after()).toEqual([]);
  await page.keyboard.type(L.prompt);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cbox .ichip')).toHaveCount(0, { timeout: 20_000 });
  const writes = (await after()).filter((f) => f.op === 'send_text');
  expect(writes).toHaveLength(1);
  const sentPath = writes[0].text!.replace(/\x1b\[20[01]~/g, '').split('\n').pop()!;
  expect(sentPath).toMatch(new RegExp(`^${L.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/images/${L.session}/[0-9a-f]{64}\\.png$`));
  expect(writes[0].text!.split(sentPath).length - 1).toBe(1);
  expect(fs.readFileSync(sentPath).equals(Buffer.from(L.png, 'base64'))).toBe(true);

  const view = page.locator(`.chat[data-session="${L.session}"]`);
  const img = view.locator('.msg.user .thumb img').first();
  await expect(img).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // The transcript itself carries the image (not only the path in the text): ask the core for the chat page.
  const events = await page.evaluate(
    ({ port, token, session }) =>
      new Promise<{ kind: string; role?: string; source?: { type: string; path?: string } }[]>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['nunchiro.v1', `nunchiro.token.${token}`]);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, chat: session }));
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.id !== 1) return;
          ws.close();
          if (m.response.Err) reject(new Error(m.response.Err));
          else resolve(m.response.Ok.page.events.map((x: { data: unknown }) => x.data));
        };
      }),
    { port: boot.port, token: boot.token, session: L.session },
  );
  const images = events.filter((e) => e.kind === 'image' && e.role === 'user');
  const replies = view.locator('.md');
  await expect(replies.first()).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: `${L.out}.chat.png` });
  const result = {
    sent: writes[0].text,
    path: sentPath,
    puts: (await frames(page)).filter((f) => f.op === 'image_put').length,
    image_events: images.map((e) => e.source?.type),
    thumb: await view.locator('.msg.user .thumb').first().getAttribute('aria-label'),
    reply: (await replies.last().innerText()).slice(0, 200),
  };
  fs.writeFileSync(L.out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  // Claude attaches each path line as a user image block. Codex 0.161 keeps the path as text and reads it with its
  // view_image tool (the script checks that tool output's input_image); its thumbnail comes from the saved path.
  if (L.agent === 'codex') expect(result.thumb).toBe(`Open image ${sentPath.split('/').pop()}`);
  else expect(images.length).toBeGreaterThan(0);
});
