// Ticket 39 (V2-3b SHOULD): the chain's earlier links hand off only to another agent. A link of the session's own
// kind is disabled ("Already this agent") and a click on it sends nothing; another kind's link still hands off.
// Three live fake agents (crates/nunchiro/tests/fixtures) are joined into one conversation in the snapshot frames.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { type Core, expect, openWindow, REPO, test } from './fixtures';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
const start = (core: Core, kind: string) => core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind).session as { id: string };

test('chain_link_disabled_for_same_kind', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  // Oldest first: an earlier Claude run, the Codex it handed off to, and the Claude shown now.
  const order = [start(core, 'claude').id, start(core, 'codex').id, start(core, 'claude').id];
  const now = order[2];
  const sent: { op: string }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).request) sent.push(JSON.parse(m).request);
      server.send(m);
    });
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      for (const s of msg.sessions) {
        const i = order.indexOf(s.id);
        if (i >= 0) Object.assign(s, { conversation: 'chain-test', attention: { ...s.attention, last_activity: i + 1 } });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${now}"]`).click();
  const nav = app.getByRole('navigation', { name: 'Conversation' });
  await expect(nav).toBeVisible();
  const links = nav.getByRole('button');
  await expect(links).toHaveCount(2);
  const same = links.nth(0);
  const other = links.nth(1);
  await expect(same).toContainText('Claude');
  await expect(same).toBeDisabled();
  await expect(same).toHaveAttribute('title', 'Already this agent');
  await expect(other).toContainText('Codex');
  await expect(other).toBeEnabled();
  await expect(other).toHaveAttribute('title', 'Hand off back to Codex (starts on Enter)');

  fs.mkdirSync(path.join(REPO, '.scratch/shots'), { recursive: true });
  await nav.screenshot({ path: path.join(REPO, `.scratch/shots/chain-link-${test.info().project.name}.png`) });

  // A click on the same-kind link reaches nothing: no preview, no chip, no send.
  await same.click({ force: true });
  await app.waitForTimeout(300);
  expect(sent.filter((r) => r.op.startsWith('handoff'))).toEqual([]);
  await expect(app.locator('[data-handoff-chip]')).toHaveCount(0);

  // An empty feed (no turn yet) misses its `article` children: a ChatList finding outside this ticket, reported.
  const r = await new AxeBuilder({ page: app }).include(`.chat[data-session="${now}"]`).exclude('.clist[role="feed"]:empty').analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // The other agent's link still hands off: the chip, from its preview; nothing is sent before Enter.
  await other.click();
  await expect(app.locator('[data-handoff-chip]')).toBeVisible();
  expect(sent.filter((r) => r.op === 'handoff_preview')).toHaveLength(1);
  expect(sent.filter((r) => r.op === 'handoff_send')).toEqual([]);
});
