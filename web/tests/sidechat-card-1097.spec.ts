// Ticket 1097: a question the docked card shows no longer opens the side pane on the session's own terminal (the same
// question twice, under "chat cannot show this question"); with the composer empty a digit picks the card's option; while
// a question with "Type something" waits, what the composer sends answers it. Real core, fake agent; the pending items are
// put into the snapshot frames and every answer is recorded and acknowledged here, never sent on.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

type Answer = { item: string; answer: { type: string; index?: number; text?: string } };
async function wire(page: Page) {
  const st = { items: {} as Record<string, unknown[]>, answers: [] as Answer[], push: () => {} };
  const sockets: WebSocketRoute[] = [];
  let last = '';
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) if (st.items[s.id]) s.pending = st.items[s.id];
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'answer') {
        st.answers.push({ item: f.request.item, answer: f.request.answer });
        return ws.send(JSON.stringify({ id: f.id, response: { Ok: 'Ack' } }));
      }
      server.send(m);
    });
    server.onMessage((m) => (typeof m === 'string' && m.includes('"event":"snapshot"') ? ws.send(patch((last = m))) : ws.send(m)));
  });
  st.push = () => {
    if (last) for (const ws of sockets) ws.send(patch(last));
  };
  return st;
}

/** A prompt only the screen detector saw (hooks silent), as the core files it: answerable unless `extra` says otherwise. */
const ask = (session: string, id: string, kind: string, text: string, labels: string[], extra: Record<string, unknown> = {}) => ({
  id,
  session_id: session,
  scope: 'x',
  kind,
  text,
  choices: labels.map((label, i) => ({ label, keys: [String(i + 1)] })),
  sources: ['screen'],
  observed_at: Date.now(),
  actionable: true,
  reconciled: true,
  ...extra,
});
const OPTIONS = ['Approve, before 1095 (recommended)', 'Approve, after 1095', 'Hold', 'Type something.', 'Chat about this'];
const QUESTION = `Place 1096?\n\n${OPTIONS.map((o, i) => `${i ? '  ' : '❯ '}${i + 1}. ${o}`).join('\n')}\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
const question = (s: string, id: string, labels = OPTIONS) => ask(s, id, 'question', QUESTION, labels);
const permission = (s: string, id: string, risky: boolean) => ask(s, id, 'permission', 'Bash command\n\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No', ['Yes', 'No'], risky ? {} : { risky: false });

async function setup(app: Page, core: Core) {
  const a = core.agent(core.project('agents'), 'a', 'never-created');
  const st = await wire(app);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  return { a, st };
}
const docked = (app: Page) => app.locator('.composer .deccard.docked');
const pane = (app: Page) => app.locator('[data-side-pane]:not([hidden])');
const box = (app: Page) => app.locator('.composer .cbox textarea:not(.hoff-edit)');
const shot = (app: Page, name: string) => {
  const dir = path.join(REPO, '.scratch/shots');
  fs.mkdirSync(dir, { recursive: true });
  return app.screenshot({ path: path.join(dir, `1097-${name}.png`) });
};

test('item1_question_on_the_card_leaves_the_side_pane_closed', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item')).toHaveCount(1);
  await app.waitForTimeout(400); // the pane opened in the same render as the card before 1097
  await shot(app, 'side-pane');
  await expect(pane(app)).toHaveCount(0);
  await expect(app.getByText('Needs your answer here: chat cannot show this question')).toHaveCount(0);
  // Round 2: the empty chat of a session with no turn points to the card, not to a terminal that is not there.
  await expect(app.locator('.chat .empty')).toContainText('Answer on the card above the message box.');
  await expect(app.locator('.chat .empty')).not.toContainText('terminal');
  // A screen-only prompt the card cannot answer (not proved yet) still opens the terminal, with its banner.
  st.items[a.id] = [ask(a.id, 'q2', 'question', QUESTION, OPTIONS, { actionable: false, reconciled: false })];
  st.push();
  await expect(pane(app).locator('.need')).toHaveText('Needs your answer here: chat cannot show this question');
  await expect(app.locator('.chat .empty')).toContainText('Answer in the terminal at the side.');
});

// Review r2 MUST: a shifted digit key is "!" (the shell cue) or "@" (a mention) and never answers the card.
test('item2_shifted_digit_stays_text', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [permission(a.id, 'p1', false)];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="p1"]')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.press('Shift+Digit1');
  await expect(box(app)).toHaveValue('!');
  await box(app).fill('');
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="q1"]')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.press('Shift+Digit2');
  await expect(box(app)).toHaveValue('@');
  await app.waitForTimeout(300);
  expect(st.answers).toHaveLength(0);
});

// Round 2: the owner types with a Korean input source. The digit is read by its key code (as the card's own keys), and a
// keydown inside a composition is the input method's. Chromium cannot switch input sources, so the keydowns are built here.
test('item2_korean_input_digit_by_code_composition_stays_text', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item')).toHaveCount(1);
  await box(app).focus();
  const down = (init: { key: string; code: string; isComposing?: boolean }) => box(app).evaluate((el, i) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
  // Inside a composition: the input method's key, never an answer.
  expect(await down({ key: '2', code: 'Digit2', isComposing: true })).toBe(true);
  await app.waitForTimeout(300);
  expect(st.answers).toHaveLength(0);
  // A key whose character is not the digit (no Shift): its code picks the option.
  expect(await down({ key: '&', code: 'Digit3' })).toBe(false);
  await expect.poll(() => st.answers).toEqual([{ item: 'q1', answer: { type: 'choose', index: 2 } }]);
  // The Korean input source's plain digit: key "1", code "Digit1".
  st.items[a.id] = [question(a.id, 'q2')];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="q2"]')).toHaveCount(1);
  await box(app).focus();
  expect(await down({ key: '1', code: 'Digit1' })).toBe(false);
  await expect.poll(() => st.answers.length).toBe(2);
  expect(st.answers[1]).toEqual({ item: 'q2', answer: { type: 'choose', index: 0 } });
});

test('item2_empty_composer_digit_picks_the_option_text_stays_text_risky_stays_text', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.press('2');
  await expect.poll(() => st.answers).toEqual([{ item: 'q1', answer: { type: 'choose', index: 1 } }]);
  await expect(box(app)).toHaveValue('');
  // A digit after text is text.
  st.items[a.id] = [question(a.id, 'q2')];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="q2"]')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.type('x1');
  await expect(box(app)).toHaveValue('x1');
  await box(app).fill('');
  // An ordinary permission: 1 allows once, as its card's key says.
  st.items[a.id] = [permission(a.id, 'p1', false)];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="p1"]')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.press('1');
  await expect.poll(() => st.answers.length).toBe(2);
  expect(st.answers[1]).toEqual({ item: 'p1', answer: { type: 'allow_once' } });
  // A risky permission: focus then Enter only; the digit stays in the box and nothing is sent.
  st.items[a.id] = [permission(a.id, 'p2', true)];
  st.push();
  await expect(docked(app).locator('.dc-item.risky[data-item="p2"]')).toHaveCount(1);
  await box(app).focus();
  await app.keyboard.press('1');
  await expect(box(app)).toHaveValue('1');
  await app.waitForTimeout(300);
  expect(st.answers).toHaveLength(2);
  await box(app).fill('');
  st.items[a.id] = [question(a.id, 'q3')];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="q3"]')).toHaveCount(1);
  await shot(app, 'docked-card');
});

test('item3_composer_send_answers_type_something_and_says_so', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item')).toHaveCount(1);
  const says = 'What you send answers its question as "Type something".';
  await expect(box(app)).toHaveAttribute('placeholder', new RegExp(`^${says.replace(/[.?*+()]/g, '\\$&')}`));
  await box(app).fill('take the recommended one');
  await expect(app.locator('.composer .chint', { hasText: says })).toBeVisible();
  await shot(app, 'composer-answers');
  await app.keyboard.press('Enter');
  await expect.poll(() => st.answers).toEqual([{ item: 'q1', answer: { type: 'choose_with', index: 3, text: 'take the recommended one' } }]);
  await expect(box(app)).toHaveValue('');
  // Without a free-text option the composer says the message waits, and Send answers nothing.
  st.items[a.id] = [question(a.id, 'q2', ['Approve', 'Hold'])];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="q2"]')).toHaveCount(1);
  await expect(box(app)).toHaveAttribute('placeholder', /A message you send now waits until you answer\./);
  await box(app).fill('later');
  await expect(app.locator('.composer .chint', { hasText: says })).toHaveCount(0);
  await app.keyboard.press('Enter');
  await app.waitForTimeout(300);
  expect(st.answers).toHaveLength(1);
});

// The composer's hint names the digit keys while a question waits (it named only Shift+Tab, so a new user took two keys).
test('digit_hint_in_empty_composer: a waiting question\'s hint says its option numbers answer it', async ({ app, core }) => {
  const { a, st } = await setup(app, core);
  st.items[a.id] = [question(a.id, 'q1')];
  st.push();
  await expect(docked(app).locator('.dc-item')).toHaveCount(1);
  await expect(box(app)).toHaveAttribute('placeholder', /Or press an option's number\. Shift\+Tab: to the card\.$/);
  await box(app).focus();
  await app.keyboard.press('3');
  await expect.poll(() => st.answers).toEqual([{ item: 'q1', answer: { type: 'choose', index: 2 } }]);
  // A permission keeps its own hint (1 allows only a safe one): no option numbers named.
  st.items[a.id] = [permission(a.id, 'p1', false)];
  st.push();
  await expect(docked(app).locator('.dc-item[data-item="p1"]')).toHaveCount(1);
  await expect(box(app)).not.toHaveAttribute('placeholder', /option's number/);
});
