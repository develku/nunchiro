// Spec Acceptance 2 with a real agent: driven by scripts/scenario/v1b-chat.sh, which starts the core and a
// Claude Haiku session and passes them in CHAT_LIVE. The window is this build; the transcript is the agent's own.
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { nunchiro, windowAuth } from './fixtures';

const live = process.env.CHAT_LIVE ? (JSON.parse(process.env.CHAT_LIVE) as { home: string; bin: string; session: string; transcript: string; out: string }) : null;

test('scenario: a real turn reading 3 files and editing one shows within 1 s of each transcript write', async ({ page }, info) => {
  test.skip(!live || info.project.name !== 'chromium', 'run through scripts/scenario/v1b-chat.sh');
  test.setTimeout(240_000);
  const L = live!;
  // The scenario's core keeps the real HOME for the agent; this spec's CLI calls get a sentinel one.
  const env = { ...process.env, NUNCHIRO_HOME: L.home, HOME: `${L.home}/sentinel-home` };
  const cli = (...a: string[]) => JSON.parse(nunchiro(env, a));
  const boot = windowAuth(L.home);
  await page.addInitScript((b) => (window.__NUNCHIRO__ = b), boot);
  await page.goto('/');
  await page.locator(`.tab[data-tab="${L.session}"]`).click();
  const view = page.locator(`.chat[data-session="${L.session}"]`);
  await expect(view.locator('.clist')).toHaveAttribute('aria-busy', 'false');
  // Page clock: when each awaited element first appears.
  await page.evaluate(() => {
    const seen: Record<string, number> = {};
    (window as { __seen?: Record<string, number> }).__seen = seen;
    const check = () => {
      const now = Date.now();
      if (!seen.user && document.querySelector('.chat:not([data-off]) .msg.user')) seen.user = now;
      if (!seen.group && [...document.querySelectorAll('.chat:not([data-off]) .tool .tl')].some((e) => /Read 3 files/.test(e.textContent ?? ''))) seen.group = now;
      if (!seen.card && document.querySelector('.chat:not([data-off]) .dcard')) seen.card = now;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  // Transcript clock: when each awaited record is written (10 ms polling).
  const written: Record<string, number> = {};
  let offset = 0;
  let rest = '';
  const poll = setInterval(() => {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(L.transcript);
    } catch {
      return;
    }
    if (buf.length <= offset) return;
    const now = Date.now();
    const lines = (rest + buf.subarray(offset).toString('utf8')).split('\n');
    offset = buf.length;
    rest = lines.pop() ?? '';
    for (const line of lines) {
      let r: { type?: string; toolUseResult?: { structuredPatch?: unknown }; message?: { content?: unknown } };
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const blocks = Array.isArray(r.message?.content) ? (r.message!.content as { type?: string; name?: string }[]) : [];
      if (r.type === 'user' && !written.user && line.includes('Use the Read tool')) written.user = now;
      if (r.type === 'assistant') {
        const reads = blocks.filter((b) => b.type === 'tool_use' && b.name === 'Read').length;
        written.reads = (written.reads ?? 0) + reads;
      }
      // The third Read call is what makes the row read "Read 3 files".
      if (!written.group && (written.reads ?? 0) >= 3) written.group = now;
      if (!written.card && r.toolUseResult?.structuredPatch) written.card = now;
    }
  }, 10);
  try {
    cli('session', 'send-text', L.session, '\x1b[200~Use the Read tool on a.txt, b.txt and c.txt (all three in one step), then use the Edit tool to replace the word alpha with ALPHA in a.txt. Do nothing else and do not run commands.\x1b[201~');
    await page.waitForTimeout(800);
    cli('session', 'send-keys', L.session, 'enter');
    await expect(view.locator('.dcard')).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => written.card ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
  } finally {
    clearInterval(poll);
  }
  const seen = (await page.evaluate(() => (window as { __seen?: Record<string, number> }).__seen))!;
  const latency = Object.fromEntries(['user', 'group', 'card'].map((k) => [k, seen[k] && written[k] ? seen[k] - written[k] : null]));
  const groups = await view.locator('.tool .tl', { hasText: /^.?Read 3 files/ }).count();
  const card = await view.locator('.dcard .counts').first().innerText();
  const result = { latency, groups, cards: await view.locator('.dcard').count(), counts: card, path: await view.locator('.dcard').first().getAttribute('data-path') };
  fs.writeFileSync(L.out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  for (const k of ['user', 'group', 'card']) {
    expect(latency[k], k).not.toBeNull();
    expect(latency[k]!, k).toBeLessThan(1000);
  }
  expect(groups).toBe(1);
  expect(result.cards).toBe(1);
  expect(card).toBe('+1 −1');
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
});
