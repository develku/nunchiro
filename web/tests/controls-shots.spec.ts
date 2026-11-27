// Pictures on request (PW_OPT_IN=shots ... --project shots): buttons, fields and focus in Settings (two pages), the
// onboarding first screen, the composer, a dialog's button row and the focus ring on a button and a field, in Nunchiro
// light and dark and Catppuccin Mocha, to compare with the design book. SHOTS_OUT names the folder, SHOTS_TAG the prefix.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test } from './fixtures';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { openSettings } from './settings-modal';

const OUT = process.env.SHOTS_OUT ?? path.resolve(import.meta.dirname, '../../.scratch/shots-controls');
const TAG = process.env.SHOTS_TAG ?? 'after';
const PICKS: [string, unknown][] = [
  ['nunchiro-light', LIGHT_PICK],
  ['nunchiro-dark', DARK_PICK],
  ['catppuccin-mocha', { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) }],
];
const file = (theme: string, view: string) => path.join(OUT, `${TAG}-${theme}-${view}.png`);
const pick = (app: Page, p: unknown) =>
  app.addInitScript((x) => {
    const was = JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}');
    localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...was, themeMode: 'fixed', themeFixed: x }));
  }, p);
const dialog = (app: Page) => app.getByRole('dialog', { name: 'Settings' });
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });

for (const [theme, p] of PICKS) {
  test(`controls_shot settings ${theme} @shots`, async ({ app, core }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p);
    await app.setViewportSize({ width: 1280, height: 800 });
    core.shell(core.project('demo'), 'one');
    await openWindow(app);
    await openSettings(app);
    for (const page of ['keys', 'providers', 'general']) {
      await nav(app).locator(`button[data-page="${page}"]`).click();
      await app.waitForTimeout(400);
      await dialog(app).screenshot({ path: file(theme, `settings-${page}`) });
    }
    // Focus on a button and a field (keyboard focus, so :focus-visible shows).
    await nav(app).locator('button[data-page="keys"]').click();
    const b = dialog(app).locator('.settings[role="region"] .btn:not(:disabled)').first();
    await b.focus();
    await app.keyboard.press('Shift+Tab');
    await app.keyboard.press('Tab');
    await app.waitForTimeout(200);
    const bb = (await b.boundingBox())!;
    await app.screenshot({ path: file(theme, 'focus-button'), clip: { x: bb.x - 40, y: bb.y - 20, width: bb.width + 80, height: bb.height + 40 } });
    const f = dialog(app).locator('nav input').first();
    await f.focus();
    await app.waitForTimeout(200);
    const fb = (await f.boundingBox())!;
    await app.screenshot({ path: file(theme, 'focus-field'), clip: { x: fb.x - 20, y: fb.y - 20, width: fb.width + 40, height: fb.height + 40 } });
  });

  test(`controls_shot dialog ${theme} @shots`, async ({ app, core }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p);
    await app.setViewportSize({ width: 1280, height: 800 });
    // The Stop question (contrast.spec openNewSession): Keep and the Stop primary.
    core.agent(core.project('demo'), 'asks', 'never');
    await openWindow(app, {}, core);
    await app.keyboard.press('Meta+KeyK');
    await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.stop"]').click();
    const d = app.getByRole('alertdialog');
    await expect(d.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await app.mouse.move(5, 795);
    await app.waitForTimeout(300);
    await d.screenshot({ path: file(theme, 'dialog') });
  });
}

test.describe('first run', () => {
  test.use({ firstRun: true });
  for (const [theme, p] of PICKS)
    test(`controls_shot onboarding ${theme} @shots`, async ({ app }) => {
      await app.emulateMedia({ reducedMotion: 'reduce' });
      await pick(app, p);
      await app.setViewportSize({ width: 1280, height: 800 });
      await app.goto('/');
      await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
      await expect(app.locator('.ob-step').first()).toBeVisible();
      await app.waitForTimeout(400);
      await app.screenshot({ path: file(theme, 'onboarding') });
    });
});

for (const [theme, p] of PICKS)
  chatTest(`controls_shot composer ${theme} @shots`, async ({ page, chatCore }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => localStorage.setItem('nunchiro.firstrun.started', '1'));
    await pick(page, p);
    await page.setViewportSize({ width: 1280, height: 800 });
    const s = chatCore.chat('composer');
    append(s.file, rec.user('Can you tidy the imports?'), rec.assistant('Done. Two files changed.'));
    await openChat(page, s.id);
    await page.locator('.composer textarea, .composer [contenteditable]').first().fill('Run the tests next');
    await page.waitForTimeout(300);
    await page.screenshot({ path: file(theme, 'composer-window') });
    await page.locator('.composer').first().screenshot({ path: file(theme, 'composer') });
  });
