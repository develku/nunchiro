// V2.5-54 A8 (needs 139): unsent composer text is kept per session, in memory and in localStorage, and comes back on a
// tab switch and after a reload. Stash (V2.5-15) is unchanged. Nothing is sent.
import { expect, openWindow, test } from './fixtures';

const box = (app: import('@playwright/test').Page) => app.locator('.cbox:visible').first().locator('textarea:not(.hoff-edit)');

test('composer_draft_survives_tab_switch_and_reload', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  const b = core.agent(core.project('a'), 'x', 'beta');
  const sent: string[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (f) => typeof f.payload === 'string' && /"op":"send_(text|keys)"/.test(f.payload) && sent.push(f.payload)));
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await box(app).fill('half a prompt for alpha');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(box(app)).toHaveValue(''); // alpha's text does not follow to beta
  await box(app).fill('beta words');
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(box(app)).toHaveValue('half a prompt for alpha');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(box(app)).toHaveValue('beta words');
  await app.reload();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(box(app)).toHaveValue('half a prompt for alpha');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(box(app)).toHaveValue('beta words');
  expect(sent).toEqual([]);
});

test('composer_draft_cleared_text_stays_cleared_after_reload', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await box(app).fill('gone soon');
  await box(app).fill('');
  await app.reload();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(box(app)).toHaveValue('');
});

test('composer_draft_stash_unchanged', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  const b = core.agent(core.project('a'), 'x', 'beta');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const cbox = app.locator('.cbox:visible').first();
  await box(app).fill('stash me');
  await cbox.getByRole('button', { name: 'Save this draft for later' }).click();
  await expect(box(app)).toHaveValue('');
  await app.locator(`.tab[data-tab="${b.id}"]`).click(); // the stashed text left the draft: it does not come back with the session
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(box(app)).toHaveValue('');
  await app.locator(`.tab[data-tab="${b.id}"]`).click();
  await app.locator('.cbox:visible').first().getByRole('button', { name: /Saved drafts \(1\)/ }).click();
  await app.locator('.cbox:visible').first().getByRole('button', { name: /^Apply: stash me/ }).click();
  await expect(box(app)).toHaveValue('stash me');
});
