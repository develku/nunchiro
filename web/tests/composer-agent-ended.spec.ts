// Ticket 286 item 1 (needs 207, card C-20261106-03): after the agent ends, the core refuses composer input with
// `agent_ended:` (crates/nunchiro-core/tests/agent_exit_shell.rs proves the refusal and that nothing reaches the shell).
// The window keeps the text in the box, sends no Enter and says why.
import { expect, openWindow, test, showComposer } from './fixtures';
import { append, chat, openChat, rec, test as chatTest, type ChatCore } from './fixtures/chat/harness';
import { startOf } from './start-op';

const AGENT_ENDED = 'agent_ended: the agent has ended; type in the terminal'; // nunchiro_core::delivery::AGENT_ENDED

test('composer_agent_ended_keeps_text_and_says_so', async ({ app, core }) => {
  const session = core.shell(core.project('p'), 'ended');
  let enters = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const msg = typeof message === 'string' ? JSON.parse(message) : null;
      if (msg?.request?.op === 'send_text' && msg.request.composer) {
        return ws.send(JSON.stringify({ id: msg.id, response: { Err: AGENT_ENDED } }));
      }
      if (msg?.request?.op === 'send_keys') enters++;
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await openWindow(app);
  await app.locator(`.tab[data-tab="${session.id}"]`).click();
  await showComposer(app);
  const textarea = app.locator('.composer textarea');
  await textarea.fill('rm -rf build');
  await app.locator('.composer .send').click();
  await expect(app.locator('.pane-status')).toHaveText('The agent has ended: type in the terminal.');
  await expect(textarea).toHaveValue('rm -rf build');
  expect(enters).toBe(0);
});

// Ticket 371 item 17: an ended session continues from its own composer, and the half-written draft follows the new id.
const snap = (core: ChatCore) => core.cli('snapshot', '--json').sessions as { id: string; state: string; agent_session_id: string }[];
const reason = (page: import('@playwright/test').Page) => page.locator('.composer .whyline');

chatTest('composer_resume_continues_with_the_draft: same tab, box enabled, draft still in it', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('half-written draft');
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(box).toBeDisabled();
  await expect(box).toHaveValue('half-written draft');
  const resume = reason(page).getByRole('button', { name: 'Continue', exact: true });
  await expect(resume).toHaveAttribute('title', 'Continue from where it stopped');
  await resume.click();
  await expect.poll(() => snap(chatCore).find((x) => x.id !== s.id && x.state === 'running')?.agent_session_id).toBe(s.agent_session_id);
  const next = snap(chatCore).find((x) => x.id !== s.id)!;
  await expect(page.locator(`.tab[data-tab="${next.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`.tab[data-tab="${s.id}"]`)).toHaveCount(0);
  await expect(chat(page, next.id).getByText('the answer')).toBeVisible();
  await expect(box).toBeEnabled();
  await expect(box).toHaveValue('half-written draft');
  await expect(reason(page)).toHaveCount(0);
});

chatTest('composer_resume_failure_keeps_the_draft_and_starts_once: a double press sends one start; the note says why until another tab is in front', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  const other = chatCore.chat();
  let starts = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const msg = typeof message === 'string' ? JSON.parse(message) : null;
      if (startOf(msg?.request)) {
        starts++;
        return void setTimeout(() => ws.send(JSON.stringify({ id: msg.id, response: { Err: 'no such folder' } })), 300);
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('kept on failure');
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(box).toBeDisabled();
  await reason(page).getByRole('button', { name: 'Continue', exact: true }).dblclick();
  await expect(page.locator('.pane-status .pane-note')).toHaveText('Not restarted: That did not work. Click this note to copy the details.');
  await expect(page.locator('.pane-status .pane-note')).toHaveAttribute('data-tip', 'no such folder');
  expect(starts).toBe(1);
  await expect(page.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(box).toHaveValue('kept on failure');
  // Look 1117 v9 Home S3-5: the note is that tab's; it does not follow into another.
  await page.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(page.locator('.pane-status .pane-note')).toHaveCount(0);
});

// v9-Home-S3-5: the "Not restarted" note belongs to its session: it leaves when another tab is shown, and it fades.
chatTest('composer_resume_failure_note_stays_with_its_session_and_fades', async ({ page, chatCore }) => {
  const s = chatCore.chat('ended', true, false, 'pair');
  const other = chatCore.chat('other', true, false, 'pair');
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const msg = typeof message === 'string' ? JSON.parse(message) : null;
      if (startOf(msg?.request)) return void ws.send(JSON.stringify({ id: msg.id, response: { Err: 'no such folder' } }));
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await openChat(page, s.id);
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  const resume = reason(page).getByRole('button', { name: 'Continue', exact: true });
  const note = page.locator('.pane-status .pane-note');
  await resume.click();
  await expect(note).toHaveText(/^Not restarted: /);
  await page.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(note).toHaveCount(0);
  await page.locator(`.tab[data-tab="${s.id}"]`).click();
  await page.clock.install();
  await resume.click();
  await expect(note).toHaveText(/^Not restarted: /);
  await page.clock.runFor(11_000);
  await expect(note).toHaveCount(0);
});

chatTest('composer_restart_label_without_a_conversation: no conversation id reads Restart', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const x of msg.sessions ?? []) x.agent_session_id = null;
      ws.send(JSON.stringify(msg));
    });
  });
  await openChat(page, s.id);
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  const restart = reason(page).getByRole('button', { name: 'Restart', exact: true });
  await expect(restart).toHaveAttribute('title', 'Start again in the same folder with the same model');
  await expect(reason(page).getByRole('button', { name: 'Continue', exact: true })).toHaveCount(0);
});

chatTest('composer_no_button_inside_an_open_terminal: an agent that ended with its shell still running keeps the reason only', async ({ page, chatCore }) => {
  const open = chatCore.chat('open');
  append(open.file, rec.user('before'), rec.assistant('the answer'));
  await openChat(page, open.id);
  chatCore.cli('session', 'send-text', open.id, 'EXIT\r');
  await expect(page.locator('.composer .why')).toHaveText('The agent has ended: type in the terminal.', { timeout: 15_000 });
  await expect(reason(page).getByRole('button')).toHaveCount(0);
});

// Ticket 991 (A1): a fresh start now runs in the session's own folder, so a worktree session with no conversation offers Restart too.
chatTest('composer_restart_for_a_worktree_session_without_a_conversation: it starts again in its own folder', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before'), rec.assistant('the answer'));
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const x of msg.sessions ?? []) Object.assign(x, { agent_session_id: null, cwd: `${x.project}/elsewhere` });
      ws.send(JSON.stringify(msg));
    });
  });
  await openChat(page, s.id);
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(page.locator('.composer .why')).toHaveText('chat is closed: read only');
  await expect(reason(page).getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
});
