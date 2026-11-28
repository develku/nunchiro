// Ticket 980: a session on an SSH machine starts from the window. Settings > SSH Machines > New session takes the folder
// on the machine; the New session list then starts the picked agent there through the core's `remote` wrapper. The
// machine and the remote core are stood in for on the window's socket (the real transport is scripts/scenario/remote.sh).
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { startOf } from './start-op';

const UP = { machine: 'macbook', host: 'macbook.local', user: 'me', port: 22, keys: [], fingerprint: null, channel: { state: 'up', since_ms: Date.now(), remote_version: '0.9.4', remote_protocol: 2, local_protocol: 2 } };
type Sent = { op: string; machine?: string; request?: { op: string; session: Record<string, unknown> } };
/** Answers `machine_details` and a remote start; adds the started session (as a row of the machine) to each snapshot. */
async function wire(app: Page, core: Core) {
  const sent: Sent[] = [];
  let remote: Record<string, unknown> | null = null;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      const r = msg.request as Sent | undefined;
      if (r?.op === 'machine_details') return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: [UP] } } }));
      const start = r?.op === 'remote' ? startOf(r.request) : null;
      if (r && start) {
        sent.push(r);
        // The remote core's reply: its own row, with no machine on it.
        const like = (core.cli('snapshot', '--json').sessions as Record<string, unknown>[])[0];
        remote = { ...like, id: 'remote-1', kind: start.session.kind, project: start.session.project, cwd: start.session.project, label: '' };
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'started', session: remote } } }));
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (msg?.event === 'snapshot' && remote) return ws.send(JSON.stringify({ ...msg, sessions: [...msg.sessions, { ...remote, machine: 'macbook' }] }));
      ws.send(raw);
    });
  });
  return sent;
}

test('remote_start_from_machines_page: the folder is typed on the machine, the agent is picked in the list, and the start goes to that machine', async ({ app, core }) => {
  core.shell(core.project('local'), 'alpha');
  const sent = await wire(app, core);
  await openWindow(app);
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'SSH machines', exact: true }).click();
  const card = app.locator('[data-machine="macbook"]');
  await card.locator('.machine-row').click();
  await card.getByRole('button', { name: 'New session', exact: true }).click();
  const form = card.getByRole('group', { name: 'New session', exact: true });
  const folder = form.getByRole('textbox', { name: 'Folder on macbook', exact: true });
  // A relative path is refused in place: a folder on another machine cannot be browsed, so it is typed in full.
  await folder.fill('app');
  await form.getByRole('button', { name: 'Choose agent', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText("Type the folder's full path on macbook, starting with /");
  await folder.fill('/srv/app');
  await form.getByRole('button', { name: 'Choose agent', exact: true }).click();
  // Settings closes on the New session list, which names the folder and the machine.
  await expect(app.locator('.settings')).toHaveCount(0);
  const list = app.getByRole('dialog', { name: 'New tab', exact: true });
  await expect(list.locator('.nt-in')).toHaveText('in app on macbook');
  await list.getByRole('option', { name: 'Claude', exact: true }).click();
  await expect(list).toHaveCount(0);
  // One start, wrapped for the machine; this Mac's model, effort and account do not go with it, and no local folder is added.
  expect(sent).toEqual([{ op: 'remote', machine: 'macbook', request: { op: 'start', session: { kind: 'claude', project: '/srv/app', model: null, effort: null, resume: null } } }]);
  expect(JSON.stringify(core.cli('snapshot', '--json'))).not.toContain('/srv/app');
});

test('remote_start_from_the_tree: the plus of a project on a machine starts the next session on that machine', async ({ app, core }) => {
  core.shell(core.project('local'), 'alpha');
  const sent = await wire(app, core);
  await openWindow(app);
  // The first session on the machine, as above; its project then shows in the tree.
  await app.evaluate(() => window.dispatchEvent(new CustomEvent('nunchiro:session.new', { detail: { project: '/srv/app', machine: 'macbook' } })));
  const list = app.getByRole('dialog', { name: 'New tab', exact: true });
  await list.getByRole('option', { name: 'New terminal', exact: true }).click();
  await expect(list).toHaveCount(0);
  // The machine's rows reach the window with the next snapshot; a local change makes the core send one.
  core.shell(core.project('local'), 'beta');
  // The project sits under its machine, not under This Mac; its plus (shown on hover) starts on that machine.
  const machine = app.getByRole('navigation', { name: 'Projects' }).getByRole('group', { name: 'macbook', exact: true });
  await expect(machine.locator('.grp[data-project="app"]')).toHaveCount(1);
  await expect(app.getByRole('navigation', { name: 'Projects' }).getByRole('group', { name: 'This Mac', exact: true }).locator('.grp[data-project="app"]')).toHaveCount(0);
  await machine.locator('.grp[data-project="app"] .row.head').hover();
  await machine.getByRole('button', { name: 'New session in app', exact: true }).click();
  await expect(list.locator('.nt-in')).toHaveText('in app on macbook');
  await list.getByRole('option', { name: 'Codex', exact: true }).click();
  expect(sent.map((s) => [s.machine, s.request?.session.kind, s.request?.session.project])).toEqual([
    ['macbook', 'shell', '/srv/app'],
    ['macbook', 'codex', '/srv/app'],
  ]);
});
