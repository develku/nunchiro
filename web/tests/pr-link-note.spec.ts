// An agent's PR linked from its terminal output (pr_live.rs link_later): the chat header's chip says so, "Linked from
// <agent>'s output", so the owner knows the app found it rather than the agent's chat. The chip reply is the core's
// shape with `linked`; the page draws the note as text beside the state.
import type { Page } from '@playwright/test';
import path from 'node:path';
import { expect, openWindow, REPO, test } from './fixtures';

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `pr-link-note-${name}-${test.info().project.name}.png`) });

test('pr link note: an auto-linked chip says it was linked from the agent output', async ({ app, core }) => {
  const project = core.project('demo');
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'calm').session as { id: string };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Set<number>();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'pr_chip' && msg.request.id === s.id) chips.add(msg.id);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg && chips.has(msg.id)) {
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'pr_chip', chip: { state: 'open', url: 'https://github.com/develku/nunchiro/pull/12', at: null, linked: 'Claude' } } } }));
      }
      ws.send(m);
    });
  });
  await openWindow(app);
  const chip = app.locator('.prchip').first();
  await expect(chip).toContainText("Linked from Claude's output");
  await shot(app, 'light');
  await app.emulateMedia({ colorScheme: 'dark' });
  await shot(app, 'dark');
});
