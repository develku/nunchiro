// Q10 (real SSH look 11-17): the tab of a session on an SSH machine. An agent there has no chat on this Mac (a chat page
// is local-only), so its tab shows its real terminal: the bytes the core reads from the machine (here stood in for on the
// window's socket), and typing goes back as the plain `send_text` the core forwards to the machine. Its pushed decision
// shows and is answered as a local one is.
import { expect, openWindow, test } from './fixtures';

const ASK = { id: 'q10-item', session_id: 'remote-1', scope: '/srv/app', kind: 'permission', text: 'Allow the fixture tool?', choices: [], sources: ['fixture'], observed_at: 1, actionable: true, reconciled: true, hook_event_id: null, risky: false };

test('remote_tab_q10: a remote agent tab shows its terminal, not a chat, and typing goes to that session', async ({ app, core }) => {
  core.shell(core.project('local'), 'alpha');
  const frames: Record<string, unknown>[] = [];
  let asking = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      const r = msg.request as { op: string; id?: string; item?: string } | undefined;
      if (msg.watch === 'remote-1' || msg.chat === 'remote-1' || r?.id === 'remote-1' || r?.item === ASK.id) {
        frames.push(msg);
        if (msg.chat) return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'operation is local owner-only; remote forwarding is not permitted' } }));
        ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'ack' } } }));
        if (msg.watch) {
          const head = Buffer.from(JSON.stringify({ session: 'remote-1', start: 0, end: 14, truncated: false, replay: true }));
          const size = Buffer.alloc(4);
          size.writeUInt32BE(head.length);
          ws.send(Buffer.concat([size, head, Buffer.from('remote$ hello\n')]));
        }
        return;
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (msg?.event === 'snapshot') {
        const like = msg.sessions[0] as Record<string, unknown>;
        const remote = { ...like, id: 'remote-1', kind: 'claude', project: '/srv/app', cwd: '/srv/app', label: 'remote agent', machine: 'macbook', pending: asking ? [ASK] : [] };
        return ws.send(JSON.stringify({ ...msg, sessions: [...msg.sessions, remote] }));
      }
      ws.send(raw);
    });
  });
  await openWindow(app);
  // A local change makes the core push a snapshot, which carries the machine's row.
  core.shell(core.project('local'), 'beta');
  const machine = app.getByRole('navigation', { name: 'Projects' }).getByRole('group', { name: 'macbook', exact: true });
  await machine.getByRole('button', { name: /^remote agent,/ }).click();
  const term = app.locator('.xterm-rows');
  await expect(term.filter({ hasText: 'remote$ hello' })).toHaveCount(1);
  // No chat page is asked for: the tab is the terminal.
  expect(frames.filter((f) => f.chat)).toEqual([]);
  await app.getByRole('textbox', { name: 'Terminal: remote agent (claude)' }).focus();
  await app.keyboard.type('x');
  await expect.poll(() => frames.some((f) => (f.request as { op?: string; text?: string } | undefined)?.op === 'send_text' && (f.request as { text?: string }).text === 'x')).toBe(true);
  // The machine pushes a permission prompt: its row shows it as a local one does, and its answer is the plain `answer`
  // the core forwards to the machine.
  asking = true;
  core.shell(core.project('local'), 'gamma');
  await machine.getByRole('button', { name: 'Allow (1)' }).click();
  await expect.poll(() => frames.some((f) => (f.request as { op?: string; item?: string } | undefined)?.op === 'answer' && (f.request as { item?: string }).item === ASK.id)).toBe(true);
});
