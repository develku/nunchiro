// Ticket 1130 B-L4 (C6, owner Q2 yes 11-25; mockup docs/design/first-use-b-1130/mockup.html #c6): T10 in two steps, paste
// a `claude mcp add` line into the composer, click the offer row. One test per mockup frame: the offer on an idle session,
// the added line after its restart, the busy session's "Add for new sessions", and a remote line with no offer. The real
// core and the fixtures' fake Claude; the window's socket is watched, never rewritten. No real `claude mcp add` runs.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { ownerOk } from './acp-fakes';

const SHOTS = path.join(REPO, 'docs/measure/shots');
const shot = (app: Page, name: string, browserName: string) => (browserName === 'chromium' ? app.screenshot({ path: path.join(SHOTS, `t10-c6-${name}.png`) }) : Promise.resolve());
type Snap = { id: string; state: string; kind: string; cwd: string; agent_session_id: string; pending: { id: string }[] };
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const LINE = 'claude mcp add github -- npx -y @modelcontextprotocol/server-github';
const box = (app: Page) => app.locator('.cbox:visible textarea:not(.hoff-edit)').first();
const offer = (app: Page) => app.locator('.mcp-offer');

/** Every request the window sends, the socket passed through unchanged. */
async function record(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r) sent.push(r);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}

/** A Claude session in my-app with one finished turn (so a restart resumes it), shown as the mockup's chat; `busy` starts a new turn. */
async function claude(app: Page, core: Core, busy = false, open = true) {
  const live = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('my-app'), '--label', open ? 'Claude' : 'Other').session as Snap;
  // The turn is written before its Stop hook, so the core reads it as finished.
  const file = core.transcriptPath(live);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The reply ends its turn as Claude writes it (`end_turn`): a transcript read after the Stop hook then reads no open turn.
  const line = (type: string, content: unknown) => JSON.stringify({ type, uuid: crypto.randomUUID(), message: { role: type, content, ...(type === 'assistant' && { stop_reason: 'end_turn' }) } }) + '\n';
  fs.writeFileSync(file, line('user', 'Open a pull request for the dark mode switch') + line('assistant', [{ type: 'text', text: 'I have no GitHub tool in this session. Add the GitHub MCP server and I can open it.' }]));
  core.hook(live.id, 'UserPromptSubmit');
  core.hook(live.id, 'Stop');
  const ask = () => sessions(core).find((s) => s.id === live.id)?.pending[0]?.id;
  await expect.poll(ask, { timeout: 15_000 }).toBeTruthy(); // the fake agent's start question
  ownerOk(core, { op: 'answer', item: ask(), answer: { type: 'allow_once' }, confirmed: true });
  await expect.poll(ask, { timeout: 15_000 }).toBeFalsy();
  if (busy) core.hook(live.id, 'UserPromptSubmit');
  if (!open) return live;
  await openWindow(app, {}, core);
  await expect(app.getByText('I have no GitHub tool in this session.').first()).toBeVisible({ timeout: 15_000 });
  return live;
}

/** A paste as the system gives it: the paste event with its text, then the text in the box and an `insertFromPaste` input. */
async function paste(app: Page, text: string) {
  await box(app).click();
  await box(app).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    const box = el as HTMLTextAreaElement;
    box.setRangeText(t, box.selectionStart, box.selectionEnd, 'end');
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: t, bubbles: true }));
  }, text);
}

test.use({ colorScheme: 'light' });

test('t10_paste_in_composer_two_steps: paste shows the offer with the whole command, one click adds it and the idle session restarts on its conversation', async ({ app, core, browserName }) => {
  const sent = await record(app);
  const live = await claude(app, core);
  // Step 1: paste. The offer names the server and shows the whole command; nothing is added, the text stays in the box.
  await paste(app, LINE);
  const row = app.getByRole('group', { name: 'Add MCP server "github"' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('npx -y @modelcontextprotocol/server-github');
  await expect(row).toContainText('This command will run in every Nunchiro session from now on. Restart keeps this conversation.');
  await expect(box(app)).toHaveValue(LINE);
  await expect(box(app)).toHaveAttribute('aria-expanded', 'false'); // the pasted @scope opens no file menu over the row
  expect(sent.filter((r) => r.op === 'extensions_mcp_add')).toEqual([]);
  await shot(app, '1-offer', browserName);
  // Step 2: the click. One sealed add, the line leaves the box, the session restarts on the same conversation.
  await row.getByRole('button', { name: 'Add and restart session' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Added github. This session restarted with it.' })).toBeVisible({ timeout: 15_000 });
  expect(sent.filter((r) => r.op === 'extensions_mcp_add')).toEqual([{ op: 'extensions_mcp_add', name: 'github', command: ['npx', '-y', '@modelcontextprotocol/server-github'] }]);
  expect(ownerOk(core, { op: 'extensions_list' }).own).toEqual([expect.objectContaining({ name: 'github', command: ['npx', '-y', '@modelcontextprotocol/server-github'] })]);
  await expect.poll(() => sessions(core).filter((s) => s.state === 'running' && s.kind === 'claude').map((s) => [s.id === live.id, s.agent_session_id]), { timeout: 15_000 }).toEqual([[false, live.agent_session_id]]);
  await expect(box(app)).toHaveValue('');
  await expect(app.getByRole('status').filter({ hasText: 'The conversation is kept. Listed in Settings > Skills & hooks, where you can remove it.' })).toBeVisible();
  await expect(offer(app).getByText('Sealed')).toBeVisible();
  await box(app).click();
  await shot(app, '2-added', browserName);
});

test('t10_busy_session_is_never_restarted: the button reads Add for new sessions; the add leaves the working session running', async ({ app, core, browserName }) => {
  const sent = await record(app);
  const live = await claude(app, core, true);
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  await paste(app, LINE);
  const row = app.getByRole('group', { name: 'Add MCP server "github"' });
  await expect(row).toContainText('Claude is busy, so this session is not restarted. It gets github after its next restart.');
  await expect(row.getByRole('button', { name: 'Add and restart session' })).toHaveCount(0);
  await shot(app, '3-busy', browserName);
  await row.getByRole('button', { name: 'Add for new sessions' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Added github. Sessions started from now on get it.' })).toBeVisible({ timeout: 15_000 });
  expect(sent.filter((r) => r.op === 'extensions_mcp_add')).toHaveLength(1);
  expect(sent.filter((r) => r.op === 'close')).toEqual([]);
  expect(sessions(core).filter((s) => s.state === 'running' && s.kind === 'claude').map((s) => s.id)).toEqual([live.id]);
  await expect(box(app)).toHaveValue('');
});

test('t10_no_offer_for_other_lines: a remote add, a codex line and a bare command stay ordinary prompts', async ({ app, core, browserName }) => {
  await claude(app, core);
  for (const line of ['codex mcp add docs -- npx docs-mcp', 'npx -y @modelcontextprotocol/server-github', 'claude mcp add --transport http notion https://mcp.notion.com/mcp']) {
    await box(app).fill('');
    await paste(app, line);
    await expect(box(app)).toHaveValue(line);
    await expect(offer(app)).toHaveCount(0);
  }
  await shot(app, '4-remote', browserName);
});

test('t10_enter_still_sends_the_line: Enter sends the pasted text as a prompt, adds nothing, and the offer goes', async ({ app, core }) => {
  const sent = await record(app);
  const live = await claude(app, core);
  await paste(app, LINE);
  await expect(offer(app)).toHaveCount(1);
  await box(app).press('Enter');
  await expect.poll(() => sent.some((r) => r.op === 'send_text' && r.id === live.id && String(r.text).includes(LINE)), { timeout: 15_000 }).toBe(true);
  await expect(offer(app)).toHaveCount(0);
  expect(sent.filter((r) => r.op === 'extensions_mcp_add')).toEqual([]);
  expect(ownerOk(core, { op: 'extensions_list' }).own).toEqual([]);
});

// Round 2 (Codex look on 8cfa18434).

test('t10_turn_started_during_the_add_is_not_ended: the core refuses the restart close and the row says new sessions', async ({ app, core }) => {
  const sent: string[] = [];
  let id = '';
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r) sent.push(r.op);
      if (r?.op === 'extensions_mcp_add') core.hook(id, 'UserPromptSubmit'); // the agent starts a turn after the window looked
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  const live = await claude(app, core);
  id = live.id;
  await paste(app, LINE);
  await app.getByRole('group', { name: 'Add MCP server "github"' }).getByRole('button', { name: 'Add and restart session' }).click();
  await expect(app.getByRole('status').filter({ hasText: 'Added github. Sessions started from now on get it.' })).toBeVisible({ timeout: 15_000 });
  expect(sent).toContain('close_idle');
  expect(sent).not.toContain('close');
  expect(sessions(core).filter((s) => s.state === 'running' && s.kind === 'claude').map((s) => s.id)).toEqual([live.id]);
});

test('t10_env_values_never_reach_storage: a pasted -e KEY=secret line is stored without its value', async ({ app, core }) => {
  await claude(app, core);
  const line = 'claude mcp add srv -e API_KEY=s3cret-value -- /bin/echo hi';
  await paste(app, line);
  await expect(app.getByRole('group', { name: 'Add MCP server "srv"' })).toContainText('Not added: the values of API_KEY.');
  await expect(box(app)).toHaveValue(line); // the box keeps what was pasted
  await expect.poll(() => app.evaluate(() => localStorage.getItem('nunchiro.composer.drafts.v1') ?? ''), { timeout: 5_000 }).toContain('claude mcp add srv -- /bin/echo hi');
  const stored = await app.evaluate(() => (dispatchEvent(new Event('pagehide')), JSON.stringify(localStorage)));
  expect(stored).not.toContain('s3cret-value');
});

test('t10_switch_during_the_add_keeps_the_other_draft: the line leaves only its own session', async ({ app, core }) => {
  let added = false;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r?.op !== 'extensions_mcp_add') return server.send(m);
      setTimeout(() => (server.send(m), (added = true)), 1500); // answered only after the switch below
    });
    server.onMessage((m) => ws.send(m));
  });
  const other = await claude(app, core, false, false);
  const a = await claude(app, core, true); // busy: no restart, so the view stays where the user went
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await paste(app, LINE);
  await app.getByRole('group', { name: 'Add MCP server "github"' }).getByRole('button', { name: 'Add for new sessions' }).click();
  await app.locator(`.tab[data-tab="${other.id}"]`).click();
  await box(app).fill('my other draft');
  await expect.poll(() => added, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => ownerOk(core, { op: 'extensions_list' }).own.length, { timeout: 15_000 }).toBe(1);
  await app.waitForTimeout(500); // the window's own continuation after the reply
  await expect(box(app)).toHaveValue('my other draft');
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(box(app)).toHaveValue('');
});

test('t10_command_shows_its_spaces: an argv word with two spaces reads as it will run', async ({ app, core }) => {
  await claude(app, core);
  await paste(app, "claude mcp add x -- /bin/echo 'a  b'");
  const shown = app.getByRole('group', { name: 'Add MCP server "x"' }).locator('.mono');
  expect(await shown.evaluate((el) => (el as HTMLElement).innerText)).toBe("/bin/echo 'a  b'");
});
