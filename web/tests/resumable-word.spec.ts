// Look 1117 v5 (C S3-6, B S3-2): after a relaunch a resumable session's header, tab and status bar read "done" while the
// tree row and the composer said "Resumable". One word everywhere.
import { expect, openWindow, test } from './fixtures';
import { mates, openSeat, openTeam, tokenClaude } from './leader-990';

test('resumable_reads_resumable_everywhere', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'chat-1');
  let ended = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (!ended || typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const v = JSON.parse(m);
      for (const x of v.sessions ?? []) if (x.id === s.id) Object.assign(x, { kind: 'claude', state: 'resumable', agent_session_id: 'a1b2c3d4-0000-4000-8000-000000000000' });
      ws.send(JSON.stringify(v));
    });
  });
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  ended = true;
  core.shell(core.project('demo'), 'nudge'); // a new snapshot carries the patched row
  await expect(app.locator(`.tabw:has(.tab[data-tab="${s.id}"]) .tdot`)).toHaveAttribute('aria-label', 'resumable');
  await expect(app.locator('.shead').first()).toContainText('resumable');
  await expect(app.locator('.shead').first()).not.toContainText(/\bdone\b/);
});

// Sixth look, Home S3: after a relaunch the Home tree rows of ended seats read "not running" while the header, the tab and
// the status bar read "resumable". A teammate that never ran still reads "not running".
test('resumable_home_rows: a Home teammate whose seat can be resumed reads "resumable" in the tree and the Team view', async ({ app, core }) => {
  tokenClaude(core);
  core.shell(core.project('demo'), 'chat-1');
  mates(core, [
    { id: 'mate-chief', name: 'Chief', lead: true },
    { id: 'mate-inbox', name: 'Inbox' },
    { id: 'mate-new', name: 'Fresh' },
  ]);
  let ended: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (!ended.length || typeof m !== 'string' || !m.includes('"event":"snapshot"')) return ws.send(m);
      const v = JSON.parse(m);
      for (const x of v.sessions ?? []) if (ended.includes(x.id)) Object.assign(x, { state: 'resumable', agent_session_id: 'a1b2c3d4-0000-4000-8000-000000000000' });
      ws.send(JSON.stringify(v));
    });
  });
  await openWindow(app, {}, core);
  const inbox = await openSeat(app, core, 'Inbox');
  const chief = await openSeat(app, core, 'Chief');
  const view = await openTeam(app);
  await view.getByRole('tab', { name: 'Assistants' }).click();
  ended = [chief, inbox];
  core.shell(core.project('demo'), 'nudge'); // a new snapshot carries the patched rows
  await expect(app.locator('.shead').first()).toContainText('resumable');
  const home = app.locator('.home-grp');
  await expect(home.locator('[data-mate="mate-chief"] .row.wt2')).toContainText('resumable');
  await expect(home.locator('[data-mate="mate-chief"] .row.wt2')).toHaveAccessibleName(/resumable/);
  await home.getByRole('button', { name: '2 resting' }).click();
  await expect(home.locator('[data-mate="mate-inbox"] .row.wt2')).toContainText('resumable');
  await expect(home.locator('[data-mate="mate-new"] .row.wt2')).toContainText('not running');
  for (const id of ['mate-chief', 'mate-inbox']) await expect(home.locator(`[data-mate="${id}"] .row.wt2`)).not.toContainText('not running');
  await expect(view.locator('.lead-row[data-mate="mate-inbox"] .lead-st')).toHaveText('resumable');
  await expect(view.locator('.lead-row[data-mate="mate-new"] .lead-st')).toHaveText('not running');
});
