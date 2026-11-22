// Ticket 197 (system basics): the page side of the native app menu's Settings…, the menu bar's waiting item, and a
// board decision notification's click. The scripts are read from main.rs itself, as about-page.spec.ts does.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, stripOnTop, test, type Core } from './fixtures';

const main = fs.readFileSync(path.join(REPO, 'app/src-tauri/src/main.rs'), 'utf8');
const script = (name: string) => {
  const s = new RegExp(`const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)";`).exec(main)?.[1];
  expect(s, `${name} in main.rs`).toBeTruthy();
  return s!.replace(/\\"/g, '"');
};
const run = (app: Page, s: string) => app.evaluate((s) => (0, eval)(s), s);

/** board.toml with a needs-decision column and one file source, `roadmap` (board-queue.spec.ts's setup). */
function board(core: Core, strip = true) {
  if (strip) stripOnTop(core, { below: true }); // the strip draws the cards a focus lands on
  const toml = `version = 1
[[columns]]
id = 'ask'
title = 'Needs decision'
needs_decision = true
states = ['needs_decision']
[sources]
version = 1
[[sources.entries]]
name = 'roadmap'
kind = 'file'
path = ${JSON.stringify(path.join(core.home, 'cards.json'))}
`;
  fs.writeFileSync(path.join(core.home, 'board.toml'), toml);
  cards(core, []);
}
function cards(core: Core, list: string[], project?: string) {
  const tmp = path.join(core.home, 'cards.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ cards: list.map((id) => ({ id, title: `Card ${id}`, updated_at: 1, needs_decision: { question: `${id}?` }, project })) }));
  fs.renameSync(tmp, path.join(core.home, 'cards.json'));
}
const card = (page: Page, id: string) => page.locator(`.qcard[data-kind="board"][data-item="integration:roadmap:${id}@1"]`);

test('app_menu_settings_opens_settings_without_page_focus', async ({ app }) => {
  const settings = script('SETTINGS_SCRIPT');
  await openWindow(app);
  await expect(app.locator('.settings')).toHaveCount(0);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await run(app, settings);
  await expect(app.locator('.settings')).toBeVisible();
  // It opens, never toggles: a second press (the page's own Cmd+comma and the menu's) leaves it open.
  await run(app, settings);
  await expect(app.locator('.settings')).toBeVisible();
});

test('tray_waiting_item_leads_to_the_waiting_item_even_while_the_window_loads', async ({ app, core }) => {
  board(core);
  core.shell(core.project('alpha'), 'alpha shell');
  // The menu bar click reopened the window: its script ran before the page listened, and before any item arrived.
  await app.addInitScript((s) => (0, eval)(s), script('WAITING_SCRIPT'));
  await openWindow(app);
  cards(core, ['one']);
  await expect(card(app, 'one')).toBeFocused();
  // In an open window it brings up the next one.
  cards(core, ['one', 'two']);
  await expect(app.getByRole('region', { name: 'Answer strip' })).toContainText('Answer strip · 2 ·');
  await run(app, script('WAITING_SCRIPT'));
  await expect(card(app, 'two')).toBeFocused();
});

test('board_notification_click_focuses_its_card', async ({ app, core }) => {
  board(core);
  core.shell(core.project('beta'), 'beta shell');
  // The app shell records `notify`; its click arrives as the event main.rs click_script sends.
  await app.addInitScript(() => {
    const w = window as unknown as { __notes: unknown[]; __TAURI_INTERNALS__: unknown; __NUNCHIRO_FOCUS__?: unknown };
    w.__notes = [];
    w.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: unknown) => (cmd === 'notify' && w.__notes.push(args), Promise.resolve(null)),
      transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
    // A click that reopened the window: the flag waits for its item to arrive.
    w.__NUNCHIRO_FOCUS__ = { id: 'integration:roadmap:late@1', at: Date.now() };
  });
  await openWindow(app);
  cards(core, ['late']);
  await expect(card(app, 'late')).toBeFocused();
  await app.waitForTimeout(1600); // items seen in the window's first 1.5 s were already waiting
  cards(core, ['late', 'new']);
  await expect.poll(() => app.evaluate(() => (window as unknown as { __notes: { session: string }[] }).__notes.map((n) => n.session))).toEqual(['integration:roadmap:new@1']);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:notify.click', { detail: { item: 'integration:roadmap:new@1' } })));
  await expect(card(app, 'new')).toBeFocused();
});

// Review round 2: the default layout has no strip; the click lands on the item's tree row, and with no row (no project)
// opens the Board.
test('board_notification_click_without_the_strip_focuses_its_tree_row', async ({ app, core }) => {
  board(core, false);
  const p = core.project('gamma');
  core.shell(p, 'gamma shell');
  await openWindow(app);
  cards(core, ['here'], p);
  const row = app.locator('.tree .q[data-item="integration:roadmap:here@1"]');
  await expect(row).toBeVisible();
  await expect(app.locator('.qcard')).toHaveCount(0);
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:notify.click', { detail: { item: 'integration:roadmap:here@1' } })));
  await expect(row).toBeFocused();
  // An item with no tree row (a card with no project draws in the strip only).
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:notify.click', { detail: { item: 'integration:roadmap:lost@1' } })));
  await expect(app.getByRole('dialog', { name: 'Board' })).toBeVisible();
});
