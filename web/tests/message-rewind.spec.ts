// Ticket 371 item 20: Rewind on one of your messages. /rewind can revert files, but only after the user confirms in the
// CLI's own picker, so the window sends the command and nothing after it. A real core and a fake Claude; the socket filter
// stands in only for what the fake cannot do: report a settled turn (a written transcript reads as working), a question, or be a Codex session.
import type { Page } from '@playwright/test';
import { append, chat, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';

type Req = { op: string; [key: string]: unknown };
type Patch = (s: { attention: Record<string, unknown>; pending: unknown[]; kind: string; id: string; project: string }) => void;

async function proxy(page: Page, patch?: Patch) {
  const sent: Req[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).request) sent.push(JSON.parse(m).request);
      server.send(m);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || !patch || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) patch(s);
      ws.send(JSON.stringify(msg));
    });
  });
  return { sent, ops: (op: string) => sent.filter((r) => r.op === op) };
}

async function open(page: Page, core: ChatCore) {
  const s = core.chat();
  append(s.file, rec.user('first-question'), rec.assistant('first-answer'));
  await openChat(page, s.id);
  const row = (text: string) => chat(page, s.id).locator('[data-menu="chat"]').filter({ hasText: text });
  await expect(row('first-question')).toBeVisible();
  return { s, row, rewind: row('first-question').getByRole('button', { name: 'Rewind', exact: true }) };
}

test('rewind_sends_one_prompt_and_opens_the_terminal: exactly /rewind, once, and no Enter or key after it', async ({ page, chatCore }) => {
  const w = await proxy(page, (x) => Object.assign(x.attention, { working: false }));
  const { s, row, rewind } = await open(page, chatCore);
  await row('first-question').hover();
  await expect(rewind).toHaveAttribute('data-tip', "Opens Claude's rewind picker in the terminal. Files change back only if you confirm there.");
  await row('first-answer').hover();
  await expect(row('first-answer').getByRole('button', { name: 'Rewind', exact: true })).toHaveCount(0); // your messages only
  await row('first-question').hover();
  await rewind.dblclick(); // a second press would land inside the open picker
  await expect(page.locator(`[data-side-pane] .term[data-session="${s.id}"]`)).toBeVisible();
  await expect.poll(() => w.ops('agent_prompt').length).toBe(1);
  expect(w.ops('agent_prompt')[0]).toEqual({ op: 'agent_prompt', id: s.id, text: '/rewind' });
  await page.waitForTimeout(500); // anything the window would send after it has gone out by now
  expect(w.ops('agent_prompt')).toHaveLength(1);
  expect(w.ops('send_keys').filter((r) => r.id === s.id)).toHaveLength(0);
  expect(w.ops('send_text').filter((r) => r.id === s.id)).toHaveLength(0);
});

const NOT_IDLE: [string, Patch][] = [
  ['working', (s) => Object.assign(s.attention, { working: true })],
  ['waiting on a question', (s) => (Object.assign(s.attention, { working: false }), s.pending =[{ id: 'd1', session_id: s.id, scope: s.project, kind: 'question', text: 'Which?', choices: [], observed_at: 1, actionable: true, risky: false }])],
];
for (const [name, patch] of NOT_IDLE) {
  test(`rewind_not_idle_sends_nothing: ${name}: aria-disabled, still focusable, the reason is readable`, async ({ page, chatCore }) => {
    const w = await proxy(page, patch);
    const { row, rewind } = await open(page, chatCore);
    await row('first-question').hover();
    await expect(rewind).toHaveAttribute('aria-disabled', 'true');
    expect(await rewind.evaluate((el) => (el as HTMLButtonElement).disabled)).toBe(false);
    await expect(rewind).toHaveAttribute('data-tip', "The agent is working, so it can't be rewound. You can press this when the turn ends.");
    await rewind.focus();
    await expect(rewind).toBeFocused();
    await rewind.click({ force: true });
    await page.waitForTimeout(300);
    expect(w.ops('agent_prompt')).toHaveLength(0);
  });
}

test('rewind_absent_on_codex: a Codex session keeps Fork and Copy and has no Rewind', async ({ page, chatCore }) => {
  await proxy(page, (s) => (s.kind = 'codex'));
  const { row, rewind } = await open(page, chatCore);
  await row('first-question').hover();
  await expect(row('first-question').getByRole('button', { name: 'Fork from here', exact: true })).toBeVisible();
  await expect(rewind).toHaveCount(0);
});

test('rewind_absent_on_ended: a closed session has no Rewind; Copy stays and Fork is as it was', async ({ page, chatCore }) => {
  const { s, row, rewind } = await open(page, chatCore);
  await row('first-question').hover();
  await expect(rewind).toBeVisible();
  chatCore.windowClose(s.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(page.locator('.composer textarea')).toBeDisabled();
  await row('first-question').hover();
  await expect(rewind).toHaveCount(0);
  await expect(row('first-question').getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
  await expect(row('first-question').getByRole('button', { name: 'Fork from here', exact: true })).toBeVisible();
});
