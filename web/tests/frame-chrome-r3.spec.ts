// CHROME round 3: one Ctrl+O listener, the view control within 2 clicks, a decision shown once.
import fs from 'node:fs';
import path from 'node:path';
import { type Core, stripOnTop, expect, openWindow, REPO, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { patchSnapshots } from './visual/compare';

const FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
const start = (core: Core, kind: string) => core.cli('session', 'start', '--kind', kind, '--project', core.project('demo'), '--label', kind).session as { id: string; cwd: string; agent_session_id: string };

test('ctrl_o_cycles_once_in_handoff_chain', async ({ app, core }) => {
  fs.copyFileSync(path.join(FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  const codex = start(core, 'codex');
  const claude = start(core, 'claude');
  const order = [codex.id, claude.id]; // an earlier Codex, then the Claude shown now
  core.said(claude); // ticket 473: the view control shows once there is a transcript
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      for (const s of msg.sessions) {
        const i = order.indexOf(s.id);
        if (i >= 0) Object.assign(s, { conversation: 'chain-r3', attention: { ...s.attention, last_activity: i + 1 } });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${order[1]}"]`).click();
  await expect(app.getByRole('navigation', { name: 'Conversation' })).toBeVisible();
  const btn = app.getByRole('button', { name: /^Transcript view/ });
  await expect(btn).toHaveCount(1); // the earlier list has no control of its own
  await expect(btn).toContainText('Normal');
  await app.keyboard.press('Control+KeyO');
  await expect(btn).toContainText('Thinking'); // one press, one step across both lists
  await app.keyboard.press('Control+KeyO');
  await expect(btn).toContainText('Verbose');
});

chatTest('transcript_view_reachable_in_2_clicks', async ({ page, chatCore }) => {
  const s = chatCore.chat('reach');
  append(s.file, rec.user('hi'), rec.use('r1', 'Read', { file_path: '/x/a' }), rec.result('r1', 'x'), rec.assistant('ok'));
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${s.id}"]`).click(); // click 1: the session
  const view = chat(page, s.id);
  await view.getByRole('button', { name: /^Transcript view/ }).click(); // click 2: the control, by its name
  await expect(view.getByRole('button', { name: /^Transcript view/ })).toContainText('Thinking');
  await expect(view.locator('.sum')).toHaveCount(1);
});

chatTest('decision_shown_once', async ({ page, chatCore }) => {
  stripOnTop(chatCore); // a window with the answer strip placed (strip on)
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Need to run it.'));
  await patchSnapshots(page, { asks: { waiting: 'permission', text: 'Bash: pnpm install' } });
  await openChat(page, s.id);
  await expect(page.locator('#waiting-strip')).toContainText('Bash: pnpm install'); // the strip shows it
  await expect(chat(page, s.id).locator('.dline')).toHaveCount(0); // so the chat does not say it again
});
