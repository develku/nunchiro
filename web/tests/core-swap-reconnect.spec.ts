// Ticket 498: after the core is swapped (a new process, new port, new token; agents stay in their holders), the open
// window reconnects to it by itself and shows the same sessions. The Tauri shell is not here: its `watch_core` sees
// `core.token` change and `hand_boot` evals `boot_script` (app/src-tauri/src/main.rs) into the page; `handBoot` below
// evals that same script with the same boot keys, so everything from the page's side of that eval on is the real path.
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, showComposer, terminalText, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';

/** What `hand_boot` gives the page once the new core answers `window_auth`: `boot()` JSON through `boot_script`. */
async function handBoot(app: Page, core: Core) {
  const boot = JSON.stringify({ ...core.boot(), ctrlSpaceTaken: false, rcUpdates: false, coreKept: false });
  await app.evaluate((s) => (0, eval)(s), `window.__NUNCHIRO__ = ${boot}; window.dispatchEvent(new Event('nunchiro:boot'));`);
}

test('after a core swap the open window reconnects to the new port and token, same sessions, no reload', async ({ app, core }) => {
  test.setTimeout(90_000);
  const p = core.project('demo');
  const a = core.shell(p, 'alpha');
  const b = core.shell(p, 'beta');
  await openWindow(app);
  const before = core.boot();
  await app.evaluate(() => ((window as unknown as { swapMark: number }).swapMark = 498)); // gone if the page reloads

  // The swap `serve update` does when the core is older (`swap_core`): the core exits, the next one starts on this home.
  core.run(['serve', 'restart'], 60_000);
  const after = core.boot();
  expect(after.port).not.toBe(before.port);
  expect(after.token).not.toBe(before.token);
  // The old connection ended; the page keeps retrying with the old address until the shell hands it the new one.
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toHaveCount(0);
  await handBoot(app, core);

  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible({ timeout: 10_000 });
  expect(await app.evaluate(() => (window as unknown as { swapMark?: number }).swapMark)).toBe(498);
  for (const s of [a, b]) await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await showComposer(app);
  const composer = app.getByLabel('Message alpha');
  await composer.fill('after-swap');
  await composer.press('Enter');
  await expect.poll(() => core.read(a.id)).toContain('after-swap');
  await expect.poll(() => terminalText(app, a.id)).toContain('after-swap'); // the window shows output again, not only the core
});

// Ticket 620 (soak 1114): the chat feed is a second socket; it kept the first boot, so after a swap it retried the old port
// every second and an open chat stopped showing new turns until the window was reloaded.
chatTest('after a core swap an open chat tab shows new turns again, from the new port', async ({ page, chatCore }) => {
  test.setTimeout(90_000);
  const s = chatCore.chat();
  append(s.file, rec.user('before swap'), rec.assistant('answer before'));
  await openChat(page, s.id);
  await expect(chat(page, s.id).getByText('answer before')).toBeVisible();
  chatCore.run(['serve', 'restart'], 60_000);
  await handBoot(page, chatCore);
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible({ timeout: 10_000 });
  append(s.file, rec.user('after swap'), rec.assistant('answer after'));
  await expect(chat(page, s.id).getByText('answer after')).toBeVisible({ timeout: 10_000 });
});
