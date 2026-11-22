// CHROME (frame-ko-d/e window chrome): tab strip, status bar, board 4-up, Settings wide view. Real core per test.
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, showComposer } from './fixtures';

const tab = (p: Page, id: string) => p.locator(`.tab[data-tab="${id}"]`);
const tabIds = (p: Page) => p.locator('.tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tab));
const bar = (p: Page) => p.locator('footer.status');

test('tab_strip_as_drawn', async ({ app, core }) => {
  const p = core.project('demo');
  const a = core.shell(p, 'one').id;
  const w = core.agent(p, 'asks', 'go');
  fs.writeFileSync(path.join(w.cwd, 'go'), '');
  await openWindow(app);
  const t = tab(app, a);
  await expect(t.locator('.ticon svg.oi[data-icon="terminal"]')).toHaveCount(1); // ticket 991 A17: a shell tab's icon is a terminal
  // q67 look Q6-2: an agent's tab shows the agent's own mark, as the "+" menu's row that starts it (it was a chat bubble).
  await expect(tab(app, w.id).locator('.ticon svg.agent-logo.claude')).toHaveCount(1);
  await expect(tab(app, w.id).locator('.ticon svg.oi')).toHaveCount(0);
  await expect(t.locator('.tname')).toHaveText('one'); // ticket 996: the icon names the kind
  await expect(t).toHaveAccessibleName(/shell · one/); // a screen reader still hears it
  const x = t.locator('..').getByRole('button', { name: /^Close tab/ });
  await expect(x).toBeHidden(); // visibility:hidden until hover or focus
  await app.locator('.title, body').first().hover();
  await t.hover();
  await expect(x).toBeVisible();
  await app.mouse.move(0, 400);
  await t.focus();
  await expect(x).toBeVisible();
  await expect(tab(app, w.id).locator('.tdot[data-s="waiting"]')).toBeVisible({ timeout: 15_000 });
  const add = app.locator('.zh').getByRole('button', { name: 'New session' });
  await expect(add).toHaveCount(1);
  await expect(add).toHaveText('');
});

test('tab_close_undo', async ({ app, core }) => {
  const p = core.project('demo');
  const [a, b, c] = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app);
  const before = await tabIds(app);
  expect(before).toEqual(expect.arrayContaining([a, b, c]));
  const at = before.indexOf(b);
  await tab(app, b).click();
  await tab(app, b).locator('..').getByRole('button', { name: /^Close tab/ }).click();
  await expect(tab(app, b)).toHaveCount(0);
  expect((core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === b)?.state).toBe('running'); // the session lives
  await expect(bar(app).locator('.undoline')).toContainText('tab closed');
  await bar(app).getByRole('button', { name: 'Undo' }).click();
  expect(await tabIds(app)).toEqual(before);
  expect((await tabIds(app)).indexOf(b)).toBe(at);
  await expect(tab(app, b)).toHaveAttribute('aria-selected', 'true');
});

// needs 154 (6), ticket 184: five default columns (To do joined needs 106's four).
test('board_five_columns', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await app.getByRole('button', { name: /^Board/ }).first().click();
  const cols = app.locator('.board .bcol');
  await expect(cols).toHaveCount(5);
  const boxes = await cols.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1); // one row
  for (const [i, b] of boxes.entries()) if (i) expect(b.left).toBeGreaterThanOrEqual(boxes[i - 1].right - 1);
  const wrap = await app.locator('.board .bcols').evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth }));
  expect(wrap.s).toBeLessThanOrEqual(wrap.c); // fills the width, no sideways scroll at 1440
  for (const h of await cols.locator('.bch').all()) {
    await expect(h.locator('b')).not.toHaveText('');
    await expect(h.locator('.bcount')).toBeVisible();
    expect(await h.evaluate((e) => getComputedStyle(e, '::before').content)).not.toBe('none'); // status dot
  }
});

test('nodup_sweep', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  const dup = () =>
    app.evaluate(() => {
      const btns = [...document.querySelectorAll<HTMLElement>('button')].filter((b) => b.offsetParent);
      // Ticket 1041: the icon bars are icons only, named like their widgets; a Settings page of the same name ("Terminal",
      // "Layout") is another place, not a second control for the same thing.
      const names = btns.filter((b) => !b.textContent?.trim() && !b.closest('nav.ib')).map((b) => b.getAttribute('aria-label')?.trim());
      return btns.filter((b) => b.textContent?.trim() && names.includes(b.textContent.trim())).map((b) => b.textContent!.trim());
    });
  expect(await dup()).toEqual([]);
  await app.getByRole('button', { name: /^Board/ }).first().click();
  expect(await dup()).toEqual([]);
  await app.keyboard.press('Escape'); // v25f: the Board modal covers the rail
  await app.getByRole('button', { name: /^Settings/ }).first().click();
  expect(await dup()).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe_frame ${scheme}`, async ({ app, core }) => {
    await app.emulateMedia({ colorScheme: scheme });
    core.shell(core.project('demo'), 'one');
    await openWindow(app);
    const run = async (what: string) => {
      const r = await new AxeBuilder({ page: app }).exclude('#key-sink').disableRules(['nested-interactive']).withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(r.violations.map((v) => `${what}: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
    };
    await run('chat');
    await app.getByRole('button', { name: /^Board/ }).first().click();
    await run('board');
    await app.keyboard.press('Escape'); // v25f: the Board modal covers the rail
    await app.getByRole('button', { name: /^Settings/ }).first().click();
    await run('settings');
  });
}

const composer = (p: Page) => p.locator('.composer').first();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('composer_as_drawn', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const ta = composer(app).getByRole('textbox');
  await expect(ta).toHaveAttribute('placeholder', 'Message one… (@ files, / commands)'); // needs 130
  expect((await composer(app).locator('.cbox').boundingBox())!.width).toBeLessThanOrEqual(760);
  const send = composer(app).getByRole('button', { name: 'Send' });
  await expect(send).toHaveText('');
  await expect(send.locator('svg')).toHaveCount(1);
  await expect(composer(app).locator('.chips .chip').first()).toBeVisible();
});

test('composer_grows_and_focus_ring', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const ta = composer(app).getByRole('textbox');
  const h0 = (await ta.boundingBox())!.height;
  await ta.focus();
  const ring = await composer(app).locator('.cbox').evaluate((e) => getComputedStyle(e).outlineStyle);
  expect(ring).toBe('solid'); // focus ring
  await ta.fill(Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n'));
  const h1 = (await ta.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0);
  await ta.fill(Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
  expect((await ta.boundingBox())!.height).toBeLessThanOrEqual(222); // the cap
  await ta.fill('');
  expect((await ta.boundingBox())!.height).toBeLessThanOrEqual(h0 + 1); // and back
});

test('composer_row_controls', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const c = composer(app);
  const send = c.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled(); // empty
  await c.getByRole('textbox').fill('hi');
  await expect(send).toBeEnabled();
  await c.getByRole('button', { name: 'Add' }).click();
  const menu = app.getByRole('menu', { name: 'Add to the message' });
  await expect(menu.getByRole('menuitem', { name: 'Attach an image' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Slash commands/ })).toHaveCount(0); // CHAT-MENUS: the / button owns it
  await expect(menu.getByRole('menuitem', { name: /Connectors/ })).toHaveCount(0); // no planned ticket (audit 11-10)
});

test('hint_line', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await expect(composer(app).locator('.chint')).toHaveCount(0); // v25-chat-calm (needs 144): only while a message waits (chat-calm.spec.ts)
});

test('attachment_chips', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const c = composer(app);
  await c.getByRole('button', { name: 'Add' }).click();
  const chooser = app.waitForEvent('filechooser');
  await app.getByRole('menuitem', { name: 'Attach an image' }).click();
  await (await chooser).setFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  const chip = c.locator('.ichip, [data-chip], .imgchip').first();
  await expect(c.getByRole('button', { name: /Remove/ })).toBeVisible();
  await expect(c.getByRole('button', { name: 'Send' })).toBeEnabled(); // an image alone is a message
  await c.getByRole('button', { name: /Remove/ }).click();
  await expect(c.getByRole('button', { name: /Remove/ })).toHaveCount(0);
  void chip;
});
