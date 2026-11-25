// Ticket 1105: the docked question card shows its header and whole question on their own lines above the options, at every
// chat width; before, five options beside the question left it one letter wide ("1…", "T…"). The owner's 5-option question
// (3 named + "Type something." + "Chat about this") and Cancel. Real core, fake agent; the pending item is put into the
// snapshot frames here (as sidechat-card-1097.spec.ts), never sent on.
import fs from 'node:fs';
import path from 'node:path';
import type { Page, WebSocketRoute } from '@playwright/test';
import { expect, openWindow, REPO, test } from './fixtures';

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
const OPTIONS = ['0 지금 + B 출시 때 (추천)', 'A 별도 macOS 사용자', 'B 지금 바로 GitHub Actions', 'Type something.', 'Chat about this'];
const HEAD = '1096 배포 서명';
const ASK = 'The release needs a signed build: sign it now on this Mac and again at release, add a separate macOS user for signing, or move signing to GitHub Actions today?';
const QUESTION = `${HEAD}\n\n${ASK}\n\n${OPTIONS.map((o, i) => `${i ? '  ' : '❯ '}${i + 1}. ${o}`).join('\n')}\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;

for (const width of [1440, 900, 560]) {
  test(`question_whole_above_the_options_at_${width}`, async ({ app, core }) => {
    await app.setViewportSize({ width, height: 900 });
    const a = core.agent(core.project('agents'), 'a', 'never-created');
    const st = await wire(app);
    await openWindow(app, {}, core);
    await app.locator(`.tab[data-tab="${a.id}"]`).click();
    await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
    st.items[a.id] = [ask(a.id, 'q1', 'question', QUESTION, OPTIONS)];
    st.push();
    const card = app.locator('.composer .deccard.docked');
    const item = card.locator('.dc-item[data-item="q1"]');
    await expect(item).toHaveCount(1);
    const dir = path.join(REPO, '.scratch/shots');
    fs.mkdirSync(dir, { recursive: true });
    await card.screenshot({ path: path.join(dir, `1105-docked-${width}.png`) });
    await app.screenshot({ path: path.join(dir, `1105-window-${width}.png`) });
    // Every text line of the question is whole: nothing scrolled out of its box, no ellipsis.
    const lines = item.locator(':scope > .dc-what, :scope > .dc-why');
    expect(await lines.count()).toBeGreaterThan(0);
    for (const el of await lines.all()) {
      const m = await el.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight, ell: getComputedStyle(e).textOverflow === 'ellipsis' && getComputedStyle(e).whiteSpace === 'nowrap' }));
      expect(m.sw, (await el.textContent()) ?? '').toBeLessThanOrEqual(m.cw);
      expect(m.sh).toBeLessThanOrEqual(m.ch);
      expect(m.ell).toBe(false);
    }
    // The question's words are on the card, above the options.
    await expect(item.locator('.dc-what')).toContainText(ASK);
    const btns = item.locator('.dc-btns');
    const [what, row] = await Promise.all([item.locator('.dc-what').boundingBox(), btns.boundingBox()]);
    expect(what!.y + what!.height).toBeLessThanOrEqual(row!.y);
    // The options and Cancel stay inside the card, wrapping onto more lines when they do not fit.
    const box = (await card.boundingBox())!;
    for (const b of await btns.locator('button').all()) {
      await expect(b).toBeVisible();
      const r = (await b.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(box.x);
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    }
    await expect(btns.locator('[data-act="deny"]')).toHaveText('Cancel');
  });
}
