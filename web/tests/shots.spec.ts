// Screenshots for the visual comparison with the approved R8 draft (not assertions).
import fs from 'node:fs';
import path from 'node:path';
import { openWindow, REPO, test } from './fixtures';
import { layoutCli } from './d5b';

const OUT = path.join(REPO, '.scratch/shots');

test('screens', async ({ app, core }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  fs.mkdirSync(OUT, { recursive: true });
  const p = core.project('nunchiro');
  const k = core.project('lumen');
  core.shell(p, 'core-serve', '/bin/zsh');
  core.agent(p, 'v1a-03', 'go-a');
  core.agent(p, 'v1a-04', 'go-b');
  core.shell(k, 'lumen-api');
  core.agent(k, 'ui-02', 'go-c');
  await openWindow(app);
  await app.waitForTimeout(600);
  await app.screenshot({ path: path.join(OUT, '1-default.png') });
  for (const [dir, f] of [[p, 'go-a'], [p, 'go-b'], [k, 'go-c']]) fs.writeFileSync(path.join(dir, f), '');
  await app.waitForTimeout(1500);
  await app.screenshot({ path: path.join(OUT, '2-waiting.png') });
  await app.keyboard.press('Meta+Comma');
  await app.waitForTimeout(300);
  await app.screenshot({ path: path.join(OUT, '3-settings.png') });
  await app.emulateMedia({ colorScheme: 'dark' });
  await app.screenshot({ path: path.join(OUT, '4-settings-dark.png') });
  await app.emulateMedia({ colorScheme: 'light' });
  await app.keyboard.press('Escape'); // v25f: Settings is a modal over the tabs; Esc closes it first
  await app.locator('.tab').first().click();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await app.waitForTimeout(200);
  await app.screenshot({ path: path.join(OUT, '5-hints.png') });
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  await app.screenshot({ path: path.join(OUT, '6-palette.png') });
  await app.keyboard.press('Escape');
  // v1a-07b: edit mode with the drawer, a drag with its drop preview, the removal notice, a power layout.
  await app.locator('nav[data-bar="right"] .lay').click();
  const card = app.locator('.lcard[data-card="terminal"]');
  await card.hover();
  await app.screenshot({ path: path.join(OUT, '7-edit.png') });
  await app.mouse.down();
  const t = (await app.locator('[data-zone-id="terminal"]').boundingBox())!;
  await app.mouse.move(t.x + t.width * 0.9, t.y + t.height / 2, { steps: 6 });
  await app.screenshot({ path: path.join(OUT, '8-drop-preview.png') });
  await app.mouse.up();
  // needs 153: no ':' command line in the window (and no screenshot of it); `nunchiro layout` takes the same words.
  await layoutCli(app, core, 'pin v1a-03 --zone terminal-2');
  await layoutCli(app, core, 'remove waiting');
  await app.screenshot({ path: path.join(OUT, '10-removal-notice.png') });
  await app.getByRole('button', { name: 'Keep it' }).click();
  await app.getByRole('button', { name: 'Done' }).click();
  await app.waitForTimeout(300);
  await app.screenshot({ path: path.join(OUT, '11-power-layout.png') });
  await app.emulateMedia({ colorScheme: 'dark' });
  await app.locator('nav[data-bar="right"] .lay').click();
  await app.locator('.drawer-wrap').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await app.screenshot({ path: path.join(OUT, '12-edit-dark.png') });
});
