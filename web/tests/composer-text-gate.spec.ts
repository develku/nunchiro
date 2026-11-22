import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, REPO, test, showComposer } from './fixtures';

test('composer_text_sends_seen', async ({ app, core }) => {
  fs.writeFileSync(
    path.join(core.home, 'bin/claude'),
    fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')),
    { mode: 0o700 },
  );
  const project = core.project('p');
  const session = core.agent(project, 'mode', 'x');
  const sent: { op: string; [key: string]: unknown }[] = [];
  app.on('websocket', (ws) => ws.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return;
    const request = JSON.parse(frame.payload).request;
    if (request) sent.push(request);
  }));
  await openWindow(app);
  await app.locator(`.tab[data-tab="${session.id}"]`).click();
  const textarea = app.locator('.composer textarea');
  await textarea.fill('first');
  await app.locator('.composer .send').click();
  await expect.poll(() => sent.filter((r) => r.op === 'send_keys').length).toBe(1);
  expect(sent.find((r) => r.op === 'send_text')).toMatchObject({ composer: true, seen: [] });

  fs.writeFileSync(path.join(project, 'dialog'), '');
  const pending = () => (core.cli('snapshot', '--json').sessions as {
    id: string; pending: { id: string }[];
  }[]).find((s) => s.id === session.id)!.pending.map((p) => p.id);
  await expect.poll(() => pending().length).toBe(1);
  const ids = pending();
  await expect(app.locator(`.tree [data-item="${ids[0]}"]`)).toBeVisible();
  await textarea.fill('second');
  await app.locator('.composer .send').click();
  await expect.poll(() => sent.filter((r) => r.op === 'send_keys').length).toBe(2);
  const texts = sent.filter((r) => r.op === 'send_text');
  const enters = sent.filter((r) => r.op === 'send_keys');
  expect(texts[1]).toMatchObject({ composer: true, seen: ids });
  expect(texts[1].seen).toEqual(enters[1].seen);
  await app.screenshot({ path: path.join(REPO, `.scratch/composer-text-${test.info().project.name}.png`) });
});

test('composer_refused_text_keeps_draft_and_sends_no_enter', async ({ app, core }) => {
  const session = core.shell(core.project('p'), 'text');
  let enters = 0;
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const msg = typeof message === 'string' ? JSON.parse(message) : null;
      if (msg?.request?.op === 'send_text') {
        return ws.send(JSON.stringify({ id: msg.id, response: { Err: 'a request you have not seen is pending' } }));
      }
      if (msg?.request?.op === 'send_keys') enters++;
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  await openWindow(app);
  await app.locator(`.tab[data-tab="${session.id}"]`).click();
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  const textarea = app.locator('.composer textarea');
  await textarea.fill('keep me');
  await app.locator('.composer .send').click();
  await expect(textarea).toHaveValue('keep me');
  expect(enters).toBe(0);
});
