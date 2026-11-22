// Ticket 419 (SessionFacts item; ticket 1031 moved the chip to the session header): the branch PR chip was read by path alone, on this Mac. An SSH session whose
// folder has the same path as a local one showed this Mac's PR. The chip now matches the machine as well as the path: a
// remote session shows only its own machine's PR (`pr_branch` runs gh on this Mac only, so it has none here).
import { expect, openWindow, test } from './fixtures';

const URL = 'https://github.com/example/demo/pull/7';

test('remote_session_no_local_pr: a session on another machine with the same path shows no PR of this Mac', async ({ app, core }) => {
  const p = core.project('demo');
  const local = core.shell(p, 'here');
  const remote = core.shell(p, 'there'); // the same folder path as `local`
  // The snapshot puts one session on `mac2`; every `pr_branch` (for that one path) is answered with a PR and logged. The
  // remote session's Remote-wrapped `diff_list` is answered here with one changed file, so its +3 −1 in the header is
  // the sign its facts were read (the same session switch asks for the diff stat and the PR chip).
  const asked: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op === 'pr_branch') {
        asked.push(msg.request.path);
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'pr_branch', pr: { url: URL, number: 7, state: 'open', failed: [] } } } }));
      }
      if (msg?.request?.op === 'remote' && msg.request.request?.op === 'diff_list' && msg.request.request.session === remote.id) {
        const files = [{ path: 'a.txt', status: 'M', additions: 3, deletions: 1 }];
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'diff_list', files } } }));
      }
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event === 'snapshot') return ws.send(JSON.stringify({ ...msg, sessions: msg.sessions.map((x: { id: string }) => (x.id === remote.id ? { ...x, machine: 'mac2' } : x)) }));
      ws.send(m);
    });
  });
  await openWindow(app);
  const chip = app.locator('.shead .prchip');
  const state = app.locator('.shead .st');

  // The local session: its folder's PR shows (the lookup works in this setup).
  await app.locator(`.tab[data-tab="${local.id}"]`).click();
  await expect(chip).toHaveCount(1);
  await expect(chip.locator('button').first()).toBeVisible();

  // The remote one, same path: once its own facts show (the faked diff stat), no PR lookup went out for it and no chip shows.
  const before = asked.length;
  await app.locator(`.tab[data-tab="${remote.id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${remote.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(state).toBeVisible();
  await expect(app.locator('.shead .hstat')).toHaveText(/\+3\s*−1/);
  expect(asked.slice(before)).toEqual([]);
  await expect(chip).toHaveCount(0);

  // Back to the local session: its PR is there again, so the remote one's empty header is not a lost lookup.
  await app.locator(`.tab[data-tab="${local.id}"]`).click();
  await expect(chip).toHaveCount(1);
});
