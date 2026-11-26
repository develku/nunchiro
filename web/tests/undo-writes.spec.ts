// ⌘Z (mockup docs/design/draft-hold/index.html, panel 5): it takes out what Nunchiro put into the composer and restores
// the owner's text exactly: words that came home from the terminal (and puts them back there), a message attached to
// his next prompt (it waits on the row again), words given back by a canceled send. After an edit of his, ⌘Z is the
// box's own undo. Snapshots are rewritten here; the core's answers to the window's requests are faked.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Snap = { id: string; draft_home?: unknown; send_queue?: unknown[]; send_log?: unknown[]; send_waits?: Record<string, string>; pending?: unknown[]; teammate?: string };
const BOT = { id: 'ada', name: 'Ada', job: 'lead', face: { shape: 'cat', tile: 'peach' }, seat: { kind: 'none' }, agent: 'claude', model: { rule: 'follow' } };
const FAKED = ['draft_taken', 'draft_put_back', 'send_attach', 'send_detach', 'typing', 'cancel_send', 'take_back'];
async function wire(app: Page) {
  const sockets = new Map<object, () => void>();
  const w = { edit: null as ((s: Snap) => void) | null, again: () => sockets.forEach((f) => f()), sent: [] as { op: string; [k: string]: unknown }[] };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request) w.sent.push(r.request);
      if (r?.request?.op === 'team_list') return ws.send(JSON.stringify({ id: r.id, response: { Ok: { teammates: [{ id: 'ada', name: 'Ada', job: 'lead', kind: 'claude' }], bots: [BOT], home: '' } } }));
      if (FAKED.includes(r?.request?.op)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'ack' } } }));
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { event?: string };
      if (f.event !== 'snapshot') return ws.send(m);
      const replay = () => {
        const copy = JSON.parse(m) as { sessions?: Snap[] };
        if (w.edit) for (const s of copy.sessions ?? []) w.edit(s);
        ws.send(JSON.stringify(copy));
      };
      sockets.set(ws, replay);
      replay();
    });
  });
  return w;
}
const MINE = 'Good. Now also rename  \n한국어 줄도 남겨 둬  ';
const undo = (app: Page) => app.locator('.composer textarea').press('Meta+KeyZ');

test('undo_words_from_the_terminal: ⌘Z restores the box byte for byte and puts the words back in the terminal', async ({ app, core }) => {
  const w = await wire(app);
  const s = core.agent(core.project('p'), 'worker', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.fill(MINE);
  w.edit = (x) => void (x.id === s.id && (x.draft_home = { words: 'check the tokenizer aga', at: 9 }));
  await expect.poll(() => (w.again(), box.inputValue())).toBe(`${MINE.replace(/\n*$/, '')}\ncheck the tokenizer aga`);
  await expect(app.locator('.composer [data-homed]')).toContainText('⌘Z');
  await undo(app);
  expect(await box.inputValue()).toBe(MINE);
  expect(w.sent.filter((r) => r.op === 'draft_put_back')).toEqual([{ op: 'draft_put_back', id: s.id, words: 'check the tokenizer aga' }]);
});

test('undo_attach: ⌘Z detaches the message; the line says it waits on the row again; the box is unchanged', async ({ app, core }) => {
  const w = await wire(app);
  const p = core.project('p');
  const lead = core.agent(p, 'lead', 'x');
  const s = core.agent(p, 'worker', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.fill(MINE);
  let wait = 'typing';
  w.edit = (x) => {
    if (x.id === lead.id) x.teammate = 'ada';
    if (x.id !== s.id) return;
    x.send_queue = [{ id: 'k1', sender: lead.id, content: 'Run the tests', status: 'queued', at: 1, completion_seq: 0, last_activity: 0, keys: [], submit: true }];
    x.send_waits = { k1: wait };
  };
  await expect.poll(() => (w.again(), app.locator('.knocks .knock').count())).toBeGreaterThan(0);
  await app.locator('.knocks .knock').first().click();
  await app.locator('.kpop').getByRole('button', { name: 'Attach to my next prompt' }).click();
  wait = 'attached';
  w.again();
  await expect(app.locator('.composer .kchip')).toBeVisible();
  await undo(app);
  await expect.poll(() => w.sent.filter((r) => r.op === 'send_detach' && r.send === 'k1').length).toBe(1);
  await expect(app.locator('.composer [data-undone]')).toHaveText("Put back. Ada's message waits on the row again.");
  expect(await box.inputValue()).toBe(MINE);
});

test('undo_given_back: ⌘Z takes out words a canceled send gave back; after an edit ⌘Z is the box own undo', async ({ app, core }) => {
  const w = await wire(app);
  const s = core.agent(core.project('p'), 'worker', 'x');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.fill(MINE);
  // A message the core holds behind a card (held.ts cardHeldRows): Cancel send gives its words back to the box.
  w.edit = (x) => {
    if (x.id !== s.id) return;
    const row = { id: 'm1', sender: 'user', content: 'held words', status: 'queued', at: 1, completion_seq: 0, last_activity: 0, keys: [], submit: true };
    x.send_queue = [row];
    x.send_log = [row];
    x.pending = [{ id: 'q1', session_id: s.id, scope: 'main', kind: 'permission', text: 'Bash ls', choices: [], observed_at: 1, actionable: true }];
  };
  const cancel = app.locator('.composer').getByRole('button', { name: 'Cancel send' });
  await expect.poll(() => (w.again(), cancel.count())).toBeGreaterThan(0);
  await cancel.first().click();
  await expect(box).toHaveValue(`held words\n${MINE}`);
  await undo(app);
  expect(await box.inputValue()).toBe(MINE);
  // Given back again, then edited: ⌘Z is the textarea's own undo, never the take-out.
  await expect.poll(() => (w.again(), cancel.count())).toBeGreaterThan(0);
  await cancel.first().click();
  await expect(box).toHaveValue(`held words\n${MINE}`);
  await box.press('End');
  await box.pressSequentially('z');
  await undo(app);
  expect(await box.inputValue()).not.toBe(MINE);
});
