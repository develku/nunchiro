// Text left in an agent's terminal box comes home (crates/nunchiro-core/src/sessions/home.rs): the snapshot's
// `draft_home` hands the words to the session's composer, which appends them once (after a line break when it holds
// text), says so, and answers `draft_taken`. The words are written into the core's snapshots here.
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';

type Snap = { id: string; draft_home?: { words: string; at: number } };
async function wire(app: Page) {
  const sockets = new Map<object, () => void>();
  const w = { home: null as Snap['draft_home'] | null, id: '', again: () => sockets.forEach((f) => f()), taken: 0 };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'draft_taken') return (w.taken++, ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'ack' } } })));
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m !== 'string') return ws.send(m);
      const f = JSON.parse(m) as { event?: string; sessions?: Snap[] };
      if (f.event !== 'snapshot') return ws.send(m);
      const replay = () => {
        const copy = JSON.parse(m) as { sessions?: Snap[] };
        for (const s of copy.sessions ?? []) if (s.id === w.id && w.home) s.draft_home = w.home;
        ws.send(JSON.stringify(copy));
      };
      sockets.set(ws, replay);
      replay();
    });
  });
  return w;
}

test('the_composer_takes_the_words_once: appended after a line break, the line shows, draft_taken answers', async ({ app, core }) => {
  const w = await wire(app);
  const s = core.agent(core.project('p'), 'worker', 'x');
  w.id = s.id;
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const box = app.locator('.composer textarea');
  await box.fill('mine');
  w.home = { words: 'check the tokenizer aga', at: 5 };
  w.again();
  await expect(box).toHaveValue('mine\ncheck the tokenizer aga');
  await expect(app.locator('.composer [data-homed]')).toContainText('Your text from the terminal is now in the composer.');
  await expect.poll(() => w.taken).toBeGreaterThan(0);
  await app.screenshot({ path: `../.scratch/shots/draft-home-${test.info().project.name}.png` });
  // The same hand-over again (the core has not seen the answer yet): taken once.
  w.again();
  w.again();
  await app.waitForTimeout(300);
  await expect(box).toHaveValue('mine\ncheck the tokenizer aga');
  // His own edit: the line goes.
  await box.press('End');
  await box.pressSequentially('in');
  await expect(app.locator('.composer [data-homed]')).toHaveCount(0);
});
