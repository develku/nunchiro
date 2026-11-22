// Ticket 550 (scorecard D4, F2): the empty lists that ticket 469 did not reach. Each one either offers a control that does
// something real or names the next step in one line (the ticket's table says which, and why each other empty needs none).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { openBoard } from './fixtures/board/coord';

const LIST = { dir: '~/.nunchiro/extensions/', items: [], mcp: [], own: [] };
const WIDGETS = { enabled: true, unavailable: null, web_enabled: true, widgets: [] };

/** The extensions page asks the core for two lists; both answer empty here, everything else goes to the real core. */
async function emptyExtensions(app: Page) {
  const answers: Record<string, unknown> = { extensions_list: LIST, widget_list: { list: WIDGETS } };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const op = msg?.request?.op as string | undefined;
      if (op && op in answers) return ws.send(JSON.stringify({ id: msg.id, response: { Ok: answers[op] } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
}

test('no_mcp: the empty MCP list offers Add a server, which puts the cursor in the server-name field', async ({ app }) => {
  await emptyExtensions(app);
  const empty = app.locator('[data-mcp="agents"] .empty');
  await expect(empty).toContainText('No MCP servers configured.');
  await empty.getByRole('button', { name: 'Add a server', exact: true }).click();
  await expect(app.getByRole('textbox', { name: 'Server name' })).toBeFocused();
});

test('no_widgets: the empty user-widget line says how one is made and where it is approved', async ({ app }) => {
  await emptyExtensions(app);
  const line = app.locator('section[data-section="widgets"] .empty');
  await expect(line).toContainText('No user widgets yet.');
  await expect(line).toContainText('Ask an agent');
  await expect(line).toContainText('Widget library');
});

test('nothing_stashed: the empty stash menu says how a draft gets in', async ({ app, core }) => {
  const a = core.agent(core.project('a'), 'x', 'alpha');
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  const box = app.locator('.cbox:visible').first();
  await box.getByRole('button', { name: 'Saved drafts (0)' }).click();
  const none = box.locator('.composer-menu .none');
  await expect(none).toContainText('No saved drafts.');
  await expect(none).toContainText('Save this draft for later');
});

test('board_no_roles: the empty role menu offers + Card, which opens the card editor', async ({ app, core }) => {
  const board = await openBoard(app, core);
  await board.locator('.bstrip').getByRole('button', { name: '+ filter' }).click();
  const menu = board.getByRole('menu', { name: 'Role filter' });
  await expect(menu).toContainText('No roles on the board');
  await menu.getByRole('button', { name: '+ Card', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(app.getByRole('dialog', { name: 'New card' })).toBeVisible();
});
