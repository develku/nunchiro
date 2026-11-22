// needs 171 / 172 (audit Board row 1): an integration card opens its URL in the user's browser through openLink
// (http(s) only, the second check after the core's), shows the destination host in its tooltip, and a card with no
// action is not a button. The cards are put into the real core's snapshot by the overlay: the core refuses a source
// with a non-http URL outright, so the refused schemes can only reach the window this way.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { cardOf, openBoard, overlay, seed } from './fixtures/board/coord';

const integ = (id: string, title: string, url: string | null) => ({
  id,
  source: 'integration',
  source_name: 'tracker',
  title,
  note: '',
  session_id: null,
  project: null,
  column: 'todo',
  state: null,
  stale: false,
  updated_at: 1,
  url,
});

/** The board with these integration cards beside the seeded ones; window.open records instead of opening. */
async function withCards(app: Page, extra: object[]) {
  await overlay(app, { board: (b) => ({ ...b, cards: [...((b.cards as object[]) ?? []), ...extra] }) });
  await app.addInitScript(() => {
    const w = window as unknown as { __opened: unknown[][] };
    w.__opened = [];
    window.open = ((...args: unknown[]) => (w.__opened.push(args), null)) as typeof window.open;
  });
}
const opened = (app: Page) => app.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);

test('integration_card_opens_url: click, Enter and Space open it in a new browser tab; the tooltip names the host', async ({ app, core }) => {
  seed(core, []);
  await withCards(app, [integ('i1', 'Tracker issue', 'https://example.test/i/1')]);
  await openBoard(app, core);
  const card = cardOf(app, 'Tracker issue');
  await expect(card).toHaveAttribute('role', 'button');
  await expect(card).toHaveAttribute('title', /example\.test/);
  await card.click();
  expect(await opened(app)).toEqual([['https://example.test/i/1', '_blank', 'noopener']]);
  await card.focus();
  await app.keyboard.press('Enter');
  await app.keyboard.press('Space');
  expect(await opened(app)).toHaveLength(3);
});

test('integration_card_scheme_refused: javascript:, file:, data: and a scheme-relative URL open nothing', async ({ app, core }) => {
  seed(core, []);
  const bad = ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//evil.test'];
  await withCards(app, bad.map((u, i) => integ(`b${i}`, `Bad ${i}`, u)));
  const errors: string[] = [];
  app.on('pageerror', (e) => errors.push(e.message));
  await openBoard(app, core);
  for (const i of bad.keys()) {
    const card = cardOf(app, `Bad ${i}`);
    await expect(card).toBeVisible();
    // The window's own check: a refused link is no action, so the card is no button either.
    await expect(card).not.toHaveAttribute('role', 'button');
    await card.click();
  }
  expect(await opened(app)).toEqual([]);
  expect(errors).toEqual([]);
});

test('integration_card_without_action_is_inert: no button role, no tab stop, no pointer, a click changes nothing', async ({ app, core }) => {
  seed(core, [{ id: 'm1', title: 'Manual task', column: 'todo' }]);
  await withCards(app, [integ('n1', 'No link', null)]);
  await openBoard(app, core);
  const card = cardOf(app, 'No link');
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute('role', 'button');
  await expect(card).not.toHaveAttribute('tabindex', /.*/);
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).not.toBe('pointer');
  const before = await app.locator('.board').innerHTML();
  await card.click();
  expect(await opened(app)).toEqual([]);
  const inner = app.locator('[role="dialog"]:not([aria-label="Board"])'); // v25f: the Board itself sits in a dialog
  await expect(inner).toHaveCount(0);
  expect(await app.locator('.board').innerHTML()).toBe(before);
  // A manual card still opens its editor.
  await cardOf(app, 'Manual task').locator('.bmain').click();
  await expect(inner).toBeVisible();
});
