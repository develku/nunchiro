// The knock (mockup docs/design/draft-hold/index.html): another sender's message waiting for a gap shows as its sender's
// face at the session's tree row; hover says why it waits, a click offers Send now, Attach to my next prompt and Later. The
// composer shows an attached message as a chip, and tells the core when the owner types (at most every 2 s). The rows are
// written into the core's snapshots here (the fake agent cannot make another sender's row wait); the choices are read off
// the window's socket and answered there.
import type { Page } from '@playwright/test';
import { type Core, expect, openWindow, test } from './fixtures';

type Row = { id: string; sender: string; content: string; status: string; at: number; completion_seq: number; last_activity: number; keys: string[]; submit: boolean };
type Snap = { id: string; label?: string; teammate?: string; send_queue?: Row[]; send_log?: Row[]; send_waits?: Record<string, string> };
const BOT = { id: 'ada', name: 'Ada', job: 'lead', face: { shape: 'cat', tile: 'peach' }, seat: { kind: 'none' }, agent: 'claude', model: { rule: 'follow' } };
const row = (id: string, sender: string, content: string): Row => ({ id, sender, content, status: 'queued', at: Date.UTC(2026, 0, 1, 14, 2), completion_seq: 0, last_activity: 0, keys: [], submit: true });

/** The window's socket: `edit` rewrites each snapshot's sessions, `sent` keeps every request op, `team_list` has Ada. */
async function wire(app: Page) {
  // Every socket the page opens (a reconnect opens another): `again` resends each one's last snapshot.
  const replays = new Map<object, () => void>();
  const w = { edit: null as ((s: Snap) => void) | null, again: () => replays.forEach((f) => f()), sent: [] as { op: string; [k: string]: unknown }[] };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request) w.sent.push(r.request);
      if (r?.request?.op === 'team_list') return ws.send(JSON.stringify({ id: r.id, response: { Ok: { teammates: [{ id: 'ada', name: 'Ada', job: 'lead', kind: 'claude' }], bots: [BOT], home: '' } } }));
      // The knock's choices and `typing` are answered here: their rows exist only in the rewritten snapshot.
      if (['send_now', 'send_later', 'send_attach', 'send_detach', 'typing'].includes(r?.request?.op)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'ack' } } }));
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { event?: string; sessions?: Snap[] };
      if (f.event !== 'snapshot') return ws.send(m);
      const replay = () => {
        const copy = JSON.parse(m) as { sessions?: Snap[] };
        if (w.edit) for (const s of copy.sessions ?? []) w.edit(s);
        ws.send(JSON.stringify(copy));
      };
      replays.set(ws, replay);
      replay();
    });
  });
  return w;
}

/** Sends the last snapshot again, rewritten, until the window has one (a snapshot comes only when something changes). */
async function apply(app: Page, w: Awaited<ReturnType<typeof wire>>, ready: string) {
  await expect.poll(async () => (w.again(), app.locator(ready).count())).toBeGreaterThan(0);
}

async function setup(app: Page, core: Core) {
  const w = await wire(app);

  const project = core.project('p');
  const lead = core.agent(project, 'lead', 'x');
  const worker = core.agent(project, 'parser-fix', 'x');
  await openWindow(app);
  return { w, lead, worker };
}

test('faces_per_sender_kind: a bot, the core, a session with no bot, and +n past three; the row state is unchanged', async ({ app, core }) => {
  const { w, lead, worker } = await setup(app, core);
  const rowOf = app.locator('.wtwrap', { has: app.locator('.row.wt2', { hasText: 'parser-fix' }) });
  w.edit = (s) => {
    if (s.id === lead.id) s.teammate = 'ada';
    if (s.id !== worker.id) return;
    s.send_queue = [row('k1', lead.id, 'Run the full test suite'), row('k2', 'core', 'heartbeat'), row('k3', 'nobody', 'hi'), row('k4', lead.id, 'four'), row('k5', lead.id, 'five')];
    s.send_waits = { k1: 'typing', k2: 'turn', k3: 'later', k4: 'turn', k5: 'turn' };
  };
  await apply(app, w, '.knocks .knock');
  const knocks = rowOf.locator('.knocks .knock');
  await expect(knocks).toHaveCount(3);
  await expect(knocks.nth(0)).toHaveAccessibleName('Message from Ada, waiting');
  await expect(knocks.nth(0).locator('.face')).toBeVisible();
  await expect(knocks.nth(1)).toHaveAccessibleName('Message from Nunchiro, waiting');
  await expect(knocks.nth(1).locator('.kglyph')).toHaveText('N');
  await expect(knocks.nth(2)).toHaveAccessibleName('Message from Another session, later');
  await expect(knocks.nth(2)).toHaveAttribute('data-later', 'true');
  await expect(rowOf.locator('.kmore')).toHaveText('+2');
  // The row's state class is the session's: the same with the knocks gone.
  const knocked = await rowOf.locator('.row.wt2').getAttribute('class');
  w.edit = null;
  w.again();
  await expect(rowOf.locator('.knocks')).toHaveCount(0);
  expect(await rowOf.locator('.row.wt2').getAttribute('class')).toBe(knocked);
});

test('popover_and_reasons: hover shows the words and why; a click offers three choices that send their requests', async ({ app, core }) => {
  const { w, lead, worker } = await setup(app, core);
  let wait = 'typing';
  w.edit = (s) => {
    if (s.id === lead.id) s.teammate = 'ada';
    if (s.id !== worker.id) return;
    s.send_queue = [row('k1', lead.id, 'Run the full test suite and report failures before you touch the parser again.')];
    s.send_waits = { k1: wait };
  };
  await apply(app, w, '.knocks .knock');
  const knock = app.locator('.knocks .knock').first();
  const reasons: [string, string][] = [
    ['typing', 'Goes in when you pause typing.'],
    ['turn', 'Goes in when this turn ends.'],
    ['direct', 'Waiting: you are typing in the terminal.'],
    ['terminal_text', 'Waiting: your text is in the terminal.'],
    ['later', 'Later: after your next prompt.'],
    ['attached', 'Attached to your next prompt.'],
  ];
  for (const [why, line] of reasons) {
    wait = why;
    w.again();
    await knock.hover();
    await expect(app.locator('.kpop .kpop-why')).toHaveText(line);
    await expect(app.locator('.kpop .kpop-n')).toHaveText('Ada');
    await app.mouse.move(0, 0);
    await expect(app.locator('.kpop')).toHaveCount(0);
  }
  wait = 'typing';
  w.again();
  for (const [name, op] of [['Send now', 'send_now'], ['Attach to my next prompt', 'send_attach'], ['Later', 'send_later']] as const) {
    await knock.click();
    await expect(app.locator('.kpop .kpop-b')).toHaveText(/^Run the full test suite/);
    await app.locator('.kpop').getByRole('button', { name }).click();
    await expect.poll(() => w.sent.filter((r) => r.op === op && r.send === 'k1' && r.id === worker.id).length).toBe(1);
    await expect(app.locator('.kpop')).toHaveCount(0);
  }
  await app.screenshot({ path: `../.scratch/shots/knock-row-${test.info().project.name}.png` });
});

test('first_300_characters: the preview is cut at 300 characters', async ({ app, core }) => {
  const { w, worker } = await setup(app, core);
  w.edit = (s) => {
    if (s.id !== worker.id) return;
    s.send_queue = [row('k1', 'core', 'x'.repeat(400))];
    s.send_waits = { k1: 'turn' };
  };
  await apply(app, w, '.knocks .knock');
  await app.locator('.knocks .knock').first().hover();
  await expect(app.locator('.kpop .kpop-b')).toHaveText(`${'x'.repeat(300)}…`);
});

test('chip_and_detach: an attached message shows over the composer; its × detaches it', async ({ app, core }) => {
  const { w, lead, worker } = await setup(app, core);
  w.edit = (s) => {
    if (s.id === lead.id) s.teammate = 'ada';
    if (s.id !== worker.id) return;
    s.send_queue = [row('k1', lead.id, 'Run the tests')];
    s.send_waits = { k1: 'attached' };
  };
  await apply(app, w, '.knocks .knock');
  await app.locator(`.tab[data-tab="${worker.id}"]`).click();
  const chip = app.locator('.composer .kchip');
  await expect(chip).toContainText('Attached: message from Ada');
  await app.screenshot({ path: `../.scratch/shots/knock-chip-${test.info().project.name}.png` });
  await chip.getByRole('button', { name: 'Detach the message from Ada' }).click();
  await expect.poll(() => w.sent.filter((r) => r.op === 'send_detach' && r.send === 'k1').length).toBe(1);
});

test('typing_throttle: the composer says the owner types at most once every 2 s, with no text', async ({ app, core }) => {
  const { w, worker } = await setup(app, core);
  await app.locator(`.tab[data-tab="${worker.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.click();
  await box.pressSequentially('hello there', { delay: 20 });
  const typing = () => w.sent.filter((r) => r.op === 'typing');
  await expect.poll(() => typing().length).toBe(1);
  expect(typing()[0]).toEqual({ op: 'typing', id: worker.id });
  await app.waitForTimeout(2100);
  await box.pressSequentially(' again', { delay: 20 });
  await expect.poll(() => typing().length).toBe(2);
});
