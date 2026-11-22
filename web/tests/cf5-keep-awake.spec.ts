// V2-CF5 (needs 124; ticket 127): "Keep this Mac awake while a session is working" in Settings > Sessions and
// startup. Off by default, stored by the core, reachable in two clicks and by keyboard, and it never writes to a PTY.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';
import { openSettings } from './settings-modal';

const SHOTS = path.join(REPO, '.scratch/keep-awake');

const LABEL = 'Keep this Mac awake while a session is working';
const HINT = 'The display can still sleep. This ends 2 minutes after the agent’s last reply. A cup icon shows in the menu bar while it is on.';
const settingsFile = (home: string) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));

/** Two clicks on visible, labelled controls from the session view: the Settings button, then Sessions and startup. */
async function openLifetime(app: import('@playwright/test').Page) {
  await openSettings(app); // one click on the gear, or none when a reload kept the modal open
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'General' }).click();
}

test('keep_awake_default_off: unchecked, off in the core, the hint beside it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await expect(box).not.toBeChecked();
  await expect(app.getByText(HINT)).toBeVisible();
  // Default off is the core's answer, not just the widget's: nothing was written.
  expect(settingsFile(core.home).keep_awake).toBeUndefined();
});

test('keep_awake_reachable_within_two_clicks: the labelled control, counted, and by keyboard', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.evaluate(() => {
    (window as unknown as { __clicks: number }).__clicks = 0;
    document.addEventListener('click', () => (window as unknown as { __clicks: number }).__clicks++, true);
  });
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await expect(box).toBeVisible();
  expect(await app.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(2);

  // Tab focus reaches it from the page's own controls, and Space toggles it.
  await box.focus();
  await expect(box).toBeFocused();
  await app.keyboard.press('Space');
  await expect(box).toBeChecked();
});

test('keep_awake_stored_by_the_core: the toggle is written and survives a restart', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await box.check();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(true);
  // Only the patched key is written.
  expect(settingsFile(core.home).keep_history).toBeUndefined();
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await openLifetime(app);
  await expect(app.getByRole('switch', { name: LABEL })).toBeChecked();
  await app.getByRole('switch', { name: LABEL }).uncheck();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(false);
});

// The full sequence (toggling, holding while a session works, releasing) with a recording fake is
// `nothing_auto_sends` in scripts/scenario/keep-awake.sh, where a session's token and a hook are at hand. Here: the
// window's half, a toggle writes no byte to any PTY.
test('nothing_auto_sends (window half): toggling writes no byte to a PTY', async ({ app, core }) => {
  // `cat` echoes every byte its PTY gets, so a stray write would land in `read`.
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const before = core.read(s.id);
  await openLifetime(app);
  const box = app.getByRole('switch', { name: LABEL });
  await box.check();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(true);
  await box.uncheck();
  await expect.poll(() => settingsFile(core.home).keep_awake).toBe(false);
  expect(core.read(s.id)).toBe(before);
});

// Design conformance page for the approved mockup's section 2 option A (run with SHOTS=1): the mockup card and the
// real pane side by side, light and dark. Not an assertion.
test('cf5 side-by-side page', async ({ app, core, browser }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  fs.mkdirSync(SHOTS, { recursive: true });
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await openLifetime(app);
  const section = app.locator('#s-lifetime');
  await expect(app.getByRole('switch', { name: LABEL })).toBeVisible();
  const mock = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const card = mock.locator('.sec').nth(1).locator('.card').first();
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(300);
    await section.screenshot({ path: path.join(SHOTS, `app-${scheme}.png`) });
    await mock.emulateMedia({ colorScheme: scheme });
    await mock.goto(`file://${path.join(SHOTS, 'cf5-draft.html')}`);
    await mock.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    await card.screenshot({ path: path.join(SHOTS, `mock-${scheme}.png`) });
  }
  const cell = (f: string) => `<a href="${f}.png"><img src="${f}.png" loading="lazy"></a>`;
  fs.writeFileSync(
    path.join(SHOTS, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>cf5-keep-awake: mockup vs app</title><style>body{font:14px system-ui;margin:16px;background:#f6f6f4;color:#1f2328}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d9e0;padding:6px;vertical-align:top;width:50%}img{width:100%;display:block}h2{margin:18px 0 4px}small{color:#59636e}</style>
<h1>cf5-keep-awake: Settings &gt; Sessions and startup, approved mockup section 2 option A (left) next to the app (right)</h1>
${(['light', 'dark'] as const).map((s) => `<h2>${s}</h2><small>The mockup card shows only the new row; the app pane is the whole section at 1440x900.</small><table><tr><th>Mockup (cf5-draft.html, section 2 A)</th><th>App</th></tr><tr><td>${cell(`mock-${s}`)}</td><td>${cell(`app-${s}`)}</td></tr></table>`).join('')}`,
  );
});
