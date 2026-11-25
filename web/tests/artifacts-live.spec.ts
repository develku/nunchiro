// Ticket v1b-07, spec Acceptance 8 with a real agent: driven by scripts/scenario/v1b-artifact-skill.sh, which starts
// the core and a Claude (or Codex) session that wrote an HTML chart into its artifact folder, and passes them in
// ARTIFACT_LIVE. The chat page must carry the file's `artifact` event with root "data" and 06's card must render it
// inline. The frame host is 06's browser stand-in (bytes only through the core's `file_read`).
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { windowAuth } from './fixtures';
import { installHost } from './fixtures/artifacts/cards/host';
import { artifactServer } from './sandbox-server';

type Live = { home: string; session: string; paths: string[]; out: string };
const live = process.env.ARTIFACT_LIVE ? (JSON.parse(process.env.ARTIFACT_LIVE) as Live) : null;

test('scenario: an HTML chart the agent wrote into its artifact folder renders inline from a data-root event', { tag: '@live' }, async ({ page }) => {
  test.setTimeout(120_000);
  const L = live!;
  expect(L.paths.length).toBeGreaterThan(0);
  const art = await artifactServer({});
  try {
    await installHost(page, art);
    const boot = windowAuth(L.home);
    await page.addInitScript((b) => (window.__NUNCHIRO__ = b), boot);
    await page.goto('/');
    await page.locator(`.tab[data-tab="${L.session}"]`).click();
    const events = await page.evaluate(
      ({ port, token, session }) =>
        new Promise<{ kind: string; root?: string; path?: string; type?: string; title?: string }[]>((resolve, reject) => {
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
    const found = events.filter((e) => e.kind === 'artifact' && e.root === 'data' && L.paths.includes(e.path!));
    expect(found.length, JSON.stringify(events.filter((e) => e.kind === 'artifact'))).toBeGreaterThan(0);
    const rel = found[found.length - 1].path!;
    const card = page.locator(`.chat[data-session="${L.session}"] .acard[data-path="${rel}"]`).last();
    await expect(card).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const body = card.frameLocator('iframe').locator('body');
    await expect(body).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${L.out}.chat.png` });
    await card.screenshot({ path: `${L.out}.card.png` });
    const result = { event: found[found.length - 1], card: await card.locator('.af-title').innerText() };
    fs.writeFileSync(L.out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await art.close();
  }
});
