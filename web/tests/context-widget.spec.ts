// Ticket 1048: the Context widget, added from the widget list, shows the session's fill from a mocked SessionContext,
// says why there is no number for an ACP session, and turns yellow then red near the limit.
// Ticket 1059: Show breakdown sends a refresh, the rows and "As of" show; disabled with a reason while working; the
// /context table record draws no chat row.
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';
import type { Session } from '../src/types';

type Counts = { used: number; window: number; model?: string; breakdown?: unknown };
/** `after`: the breakdown the core reports once a refresh came in (Claude wrote its /context table). */
async function fake(page: Page, counts: Counts, after?: unknown) {
  const overrides = new Map<string, Partial<Session> | ((s: Session) => Partial<Session>)>();
  const refreshes: string[] = [];
  let sessions: Session[] = [];
  const pushes: (() => void)[] = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const patch = (s: Session) => {
      const o = overrides.get(s.id);
      return typeof o === 'function' ? o(s) : o;
    };
    const push = () => ws.send(JSON.stringify({ event: 'snapshot', sessions: sessions.map((s) => ({ ...s, ...patch(s) })) }));
    pushes.push(push);
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.request?.op === 'session_context') {
        if (frame.request.refresh) {
          refreshes.push(frame.request.id);
          if (after) counts.breakdown = after;
        }
        ws.send(JSON.stringify({ id: frame.id, response: { Ok: { type: 'session_context', ...counts } } }));
      }
      else server.send(m);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.event === 'snapshot') { sessions = frame.sessions; push(); } else ws.send(m);
    });
  });
  return { refreshes, state: (id: string, patch: Partial<Session> | ((s: Session) => Partial<Session>)) => { overrides.set(id, patch); pushes.forEach((p) => p()); } };
}

/** Adds the Context widget from the widget list (Enter on its card puts its icon in the left bar), moves the icon to the
 *  right bar (Alt+Right, as a user does in Layout), then opens it there. */
async function addWidget(page: Page) {
  await page.locator('nav[data-bar="right"] .lay').click();
  const card = page.locator('.lcard[data-card="context"]');
  await expect(card).toHaveAttribute('aria-label', /^Context widget/);
  await card.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Context', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await page.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
  const w = page.locator('.sbar[data-widget="context"] .ctxw');
  // The first click on an icon just moved in Layout is not taken (the bar's own behaviour, outside this ticket): click until it opens.
  await expect(async () => {
    if (!(await w.count())) await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Context', exact: true }).click();
    await expect(w).toBeVisible({ timeout: 500 });
  }).toPass();
  return w;
}

test('context_widget_shows_fill_of_the_session', async ({ page, chatCore }) => {
  const s = chatCore.chat('context');
  await fake(page, { used: 359_900, window: 1_000_000, model: 'claude-fable-5-2' });
  await openChat(page, s.id);
  const w = await addWidget(page);
  await expect(w.locator('.ctxw-head b')).toHaveText('36% used');
  await expect(w.locator('.ctxw-n')).toHaveText('359.9K / 1M');
  await expect(w.locator('.ctxw-model')).toHaveText('claude-fable-5-2');
  await expect(w.locator('.ctxw-src')).toHaveText('From the last response');
  await expect(w.locator('.ctxw-bar')).toHaveAttribute('aria-valuenow', '36');
  await expect(w.locator('.ctxw-bar')).not.toHaveClass(/warn|bad/);
});

test('context_widget_says_why_for_an_acp_session', async ({ page, chatCore }) => {
  const s = chatCore.chat('acp');
  const f = await fake(page, { used: 1, window: 10 });
  await openChat(page, s.id);
  f.state(s.id, { kind: 'acp' });
  const w = await addWidget(page);
  await expect(w.locator('.ctxw-why')).toHaveText('Not available: this agent does not report its context.');
  await expect(w.locator('.ctxw-bar')).toHaveCount(0);
});

for (const [used, tone] of [[850_000, 'warn'], [950_000, 'bad']] as const)
  test(`context_widget_${tone}_near_the_limit`, async ({ page, chatCore }) => {
    const s = chatCore.chat(tone);
    await fake(page, { used, window: 1_000_000 });
    await openChat(page, s.id);
    const w = await addWidget(page);
    await expect(w.locator('.ctxw-bar')).toHaveClass(new RegExp(`\\b${tone}\\b`));
  });

test('context_widget_breakdown_on_request', async ({ page, chatCore }) => {
  const s = chatCore.chat('breakdown');
  const at = Date.UTC(2026, 10, 23, 2, 22);
  const rows = [
    { label: 'System prompt', tokens: 4500, pct: 0.4 },
    { label: 'Messages', tokens: 232_500, pct: 23.2 },
    { label: 'Free space', tokens: 711_300, pct: 71.1 },
  ];
  const f = await fake(page, { used: 255_700, window: 1_000_000 }, { at, rows });
  await openChat(page, s.id);
  f.state(s.id, (x) => ({ state: 'running', pending: [], attention: { ...x.attention, working: false, waiting: false, stale: false } }));
  const w = await addWidget(page);
  const button = w.getByRole('button', { name: 'Show breakdown' });
  await expect(button).toBeEnabled();
  await expect(w.locator('.ctxw-note')).toHaveText('Sends /context to the agent. It adds a short note (about 1 to 2 thousand tokens) to the conversation.');
  await expect(w.locator('.ctxw-rows')).toHaveCount(0);
  await button.click();
  await expect(w.locator('.ctxw-rows li')).toHaveCount(3);
  await expect(w.locator('.ctxw-rows li').first()).toContainText('System prompt');
  await expect(w.locator('.ctxw-rows li').first()).toContainText('4.5K · 0.4%');
  await expect(w.locator('.ctxw-rows li').nth(2).locator('.ctxw-rowbar i')).toHaveAttribute('style', /width: 71\.1%/);
  await expect(w.getByText(/^As of /)).toBeVisible();
  await expect(w.getByRole('button', { name: 'Refresh' })).toBeVisible();
  expect(f.refreshes).toEqual([s.id]);
});

test('context_widget_breakdown_disabled_while_working', async ({ page, chatCore }) => {
  const s = chatCore.chat('busy');
  const f = await fake(page, { used: 1000, window: 1_000_000 });
  await openChat(page, s.id);
  f.state(s.id, (x) => ({ state: 'running', pending: [], attention: { ...x.attention, working: true, waiting: false, stale: false } }));
  const w = await addWidget(page);
  const button = w.getByRole('button', { name: 'Show breakdown' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', 'Available when the agent is idle.');
  expect(f.refreshes).toEqual([]);
});

test('context_table_record_draws_no_chat_row', async ({ page, chatCore }) => {
  const s = chatCore.chat('nochatrow');
  const table = '## Context Usage\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| Messages | 1k | 0.1% |\n';
  append(s.file, rec.user('hello before context'), { type: 'user', isMeta: true, uuid: '00000000-0000-4000-8000-0000000010a9', message: { role: 'user', content: table } }, rec.assistant('after context'));
  await openChat(page, s.id);
  await expect(chat(page, s.id)).toContainText('after context');
  await expect(chat(page, s.id)).not.toContainText('Estimated usage by category');
  await expect(chat(page, s.id)).not.toContainText('Context Usage');
});
