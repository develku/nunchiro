// A plugin's check that stops the owner's start (docs/plugins.md, Checks) says so in the same short line as a memory
// hold, with Start anyway, which sends the same start as the owner's `start_anyway` (the core lets the owner past a
// check; crates/nunchiro/tests/plugin_gates.rs checks the core's side). The core's refusal is faked here.
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const STOPPED = 'Quiet hours stopped this start: Quiet hours until 07:00.';
type Snap = { id: string; project: string; state: string; kind: string };
const agents = (core: Core) => (core.cli('snapshot', '--json').sessions as Snap[]).filter((s) => s.kind === 'claude' && s.state === 'running');

async function stopStarts(app: Page) {
  const sent: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      const r = frame?.request;
      if (r?.op === 'start' || r?.op === 'start_anyway' || r?.op === 'start_or_wait') sent.push(r.op);
      if ((r?.op === 'start_or_wait' || r?.op === 'start') && (r.session?.kind ?? r.start?.session?.kind) !== 'shell') return ws.send(JSON.stringify({ id: frame.id, response: { Err: STOPPED } }));
      if (r?.op === 'start_anyway' && r.start?.op === 'start') return server.send(JSON.stringify({ ...frame, request: r.start }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

test('plugin_check_note_starts_anyway: a start a plugin stopped says why, and Start anyway starts it', async ({ app, core }) => {
  const p = core.project('api-server');
  core.shell(p, 'main-shell');
  openQuiet(core);
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') === null && localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'onboarding.default_agent': 'claude' } })));
  const sent = await stopStarts(app);
  await openWindow(app);
  const head = app.locator('.row.head', { hasText: 'api-server' });
  await head.hover();
  await head.getByRole('button', { name: 'New Claude session in api-server' }).click();
  const bar = app.locator('.pane-status');
  await expect(bar).toContainText(STOPPED);
  const anyway = bar.getByRole('button', { name: 'Start anyway' });
  await expect(anyway).toHaveAttribute('data-tip', "Start it now, past the plugin's check, this once.");
  await anyway.click();
  await expect.poll(() => agents(core).map((s) => s.project), { timeout: 15_000 }).toEqual([p]);
  expect(sent).toEqual(['start_or_wait', 'start_anyway']);
});
