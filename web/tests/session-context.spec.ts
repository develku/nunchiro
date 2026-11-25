import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';
import { EN } from './i18n-tables';
import type { Session } from '../src/types';
const ROOT = path.resolve(import.meta.dirname, '../..');
const component = () => fs.readFileSync(path.join(ROOT, 'web/src/chat/ContextRing.tsx'), 'utf8');
const ring = (p: Page) => p.locator('.composer .context-ring');
async function fake(page: Page, counts: { used: number; window: number; model?: string; effort?: string } = { used: 124000, window: 200000 }) {
  const requests: string[] = [];
  const sends: string[] = [];
  let unknown = false;
  let sessions: Session[] = [];
  const pushes: (() => void)[] = [];
  const overrides = new Map<string, Partial<Session>>();
  const copies: [string, string][] = []; // [source id, copy id]: one synthetic snapshot row beside the real one (the next replaces it)
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const push = () => ws.send(JSON.stringify({ event: 'snapshot', sessions: [...sessions, ...copies.flatMap(([from, id]) => sessions.filter((s) => s.id === from).map((s) => ({ ...s, id })))].map((s) => ({ ...s, ...overrides.get(s.id) })) }));
    pushes.push(push);
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (['send_text', 'send_keys'].includes(frame?.request?.op)) sends.push(frame.request.op);
      if (frame?.request?.op === 'session_context') {
        requests.push(frame.request.id);
        ws.send(JSON.stringify({ id: frame.id, response: { Ok: unknown ? { type: 'unknown' } : { type: 'session_context', ...counts } } }));
      } else server.send(m);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.event === 'snapshot') { sessions = frame.sessions; push(); } else ws.send(m);
    });
  });
  return { requests, sends, unknown: () => { unknown = true; }, known: () => { unknown = false; }, state: (id: string, patch: Partial<Session>) => { overrides.set(id, patch); pushes.forEach((push) => push()); }, copy: (from: string, id: string) => { copies.splice(0, copies.length, [from, id]); pushes.forEach((push) => push()); } };
}
function sessions(core: ChatCore) { return [core.chat('first', true, false, 'pair'), core.chat('second', true, false, 'pair')]; } // ticket 570: one project, one strip
test('ring_shows_fraction', async ({ page, chatCore }) => {
  const s = chatCore.chat('context'); await fake(page); await openChat(page, s.id);
  await expect(ring(page)).toHaveAttribute('aria-label', 'Context 124k / 200k');
  await expect(ring(page)).toHaveAttribute('title', 'Context 124k / 200k');
  expect(await ring(page).evaluate((e) => e.style.getPropertyValue('--context-fill'))).toBe('62%');
  expect(await ring(page).getAttribute('title')).not.toMatch(/limit|remaining|%/i);
  expect(await ring(page).evaluate((e) => getComputedStyle(e).backgroundImage)).not.toBe('none');
});
test('ring_hidden_when_unknown', async ({ page, chatCore }) => {
  const [a,b] = sessions(chatCore); const f = await fake(page); await openChat(page, a.id);
  await expect(ring(page)).toBeVisible(); f.unknown(); await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect.poll(() => f.requests.includes(b.id)).toBe(true); await expect(ring(page)).toHaveCount(0);
  f.state(b.id, { machine: 'remote' }); await expect(ring(page)).toHaveCount(0);
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(ring(page)).toBeVisible(); // a known cached value must also disappear for a remote session
  const requests = f.requests.length;
  f.state(a.id, { machine: 'remote' });
  await expect(ring(page)).toHaveCount(0);
  expect(f.requests).toHaveLength(requests);
});
test('ring_refresh_cadence', async ({ page, chatCore }) => {
  const [a,b] = sessions(chatCore);
  // A chat with no messages seats its composer in the empty block, which a working flag clears (v25-empty, needs 140):
  // every working toggle would remount the ring. A conversation with a turn keeps one composer, as after any first send.
  append(a.file, rec.user('first'), rec.assistant('answer'));
  const f = await fake(page); await openChat(page, a.id);
  await expect.poll(() => f.requests.filter((id) => id === a.id).length).toBe(1);
  const before = f.requests.filter((id) => id === b.id).length;
  await page.clock.install(); await page.clock.fastForward(61000);
  expect(f.requests.filter((id) => id === a.id)).toHaveLength(1); // no timer-driven request
  expect(f.requests.filter((id) => id === b.id)).toHaveLength(before); // no background-chat request
  const attention = (working: boolean) => ({ working, waiting: false, stale: false, failed: false, last_activity: 1 });
  f.state(a.id, { attention: attention(true) }); await page.clock.runFor(100);
  await expect(page.locator('.composer button.send.stop')).toBeVisible();
  f.state(a.id, { attention: attention(false) }); await page.clock.runFor(100);
  await expect.poll(() => f.requests.filter((id) => id === a.id).length).toBe(2);
  f.state(a.id, { attention: attention(true) }); await page.clock.runFor(100); await expect(page.locator('.composer button.send.stop')).toBeVisible();
  f.state(a.id, { attention: attention(false) }); await page.clock.runFor(100); await expect(page.locator('.composer button.send.stop')).toHaveCount(0);
  expect(f.requests.filter((id) => id === a.id)).toHaveLength(2);
  await page.clock.fastForward(31000);
  f.state(a.id, { attention: attention(true) }); await page.clock.runFor(100);
  await expect(page.locator('.composer button.send.stop')).toBeVisible();
  f.state(a.id, { state: 'failed', attention: attention(false) }); await page.clock.runFor(100);
  await expect(page.locator('.composer button.send.stop')).toHaveCount(0);
  expect(f.requests.filter((id) => id === a.id)).toHaveLength(2); // failure is not an idle/waiting turn end
  f.state(a.id, { state: 'running', attention: attention(false) }); await page.clock.runFor(100);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.fastForward(31000); await page.locator(`.tab[data-tab="${b.id}"]`).click();
  expect(f.requests.filter((id) => id === b.id)).toHaveLength(before);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => f.requests.filter((id) => id === b.id).length).toBe(before + 1);
});
test('model_chip_rereads_an_unknown_value_at_the_first_turn_end: a new session read before its transcript names a model reads again when its first turn ends inside the 30 s bound (ticket 991 B15)', async ({ page, chatCore }) => {
  const s = chatCore.chat('fresh');
  append(s.file, rec.user('first'), rec.assistant('answer'));
  const f = await fake(page, { used: 1000, window: 200000, model: 'claude-sonnet-5-5' });
  f.unknown();
  await openChat(page, s.id);
  await expect.poll(() => f.requests.filter((id) => id === s.id).length).toBe(1);
  const chip = page.locator('.composer [data-picker="model"]');
  await expect(chip).toHaveText('Claude');
  f.known();
  const attention = (working: boolean) => ({ working, waiting: false, stale: false, failed: false, last_activity: 1 });
  f.state(s.id, { attention: attention(true) });
  await expect(page.locator('.composer button.send.stop')).toBeVisible();
  f.state(s.id, { attention: attention(false) });
  await expect.poll(() => f.requests.filter((id) => id === s.id).length).toBe(2);
  await expect(chip).toHaveText('Claude · Sonnet 5.5');
});
// v11-A-S3-5: a read that cannot tell (the core restarting, a dropped socket) never erases the effort the session had.
test('effort_chip_keeps_a_known_effort_over_an_unknown_read (v11-A-S3-5)', async ({ page, chatCore }) => {
  const s = chatCore.chat('restarted');
  append(s.file, rec.user('first'), rec.assistant('answer'));
  const f = await fake(page, { used: 1000, window: 200000, model: 'claude-sonnet-5-5', effort: 'medium' });
  await openChat(page, s.id);
  const chip = page.locator('.composer [data-picker="effort"]');
  await expect(chip).toHaveText('effort medium');
  f.unknown();
  await page.clock.install(); await page.clock.fastForward(31000);
  const attention = (working: boolean) => ({ working, waiting: false, stale: false, failed: false, last_activity: 1 });
  f.state(s.id, { attention: attention(true) }); await page.clock.runFor(100);
  await expect(page.locator('.composer button.send.stop')).toBeVisible();
  f.state(s.id, { attention: attention(false) }); await page.clock.runFor(100);
  await expect.poll(() => f.requests.filter((id) => id === s.id).length).toBe(2);
  await expect(chip).toHaveText('effort medium');
});
const english = (s: string) => {
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/(?<![=\-])>\s*([A-Za-z][^<>{}]*?)\s*<(?=[\/A-Za-z])|(?:title|aria-label|data-tip)="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
};
test('ring_text_from_catalogue', () => {
  expect((EN as Record<string,string>)['chat.context']).toBe('Context {used} / {window}');
  expect(english(component())).toEqual([]);
  expect(english(component() + '\n<span title="Context">Hello</span>')).toEqual(['Context', 'Hello']);
});
test('ring_no_new_control', async ({ page, chatCore }) => {
  const s = chatCore.chat('info'); const f = await fake(page); await openChat(page,s.id); await expect(ring(page)).toBeVisible();
  expect(await ring(page).evaluate((e) => ({ tag: e.tagName, tab: e.tabIndex, click: e.onclick }))).toEqual({ tag: 'SPAN', tab: -1, click: null });
  const input = page.locator('.composer textarea').first();
  await input.fill('first line'); await input.press('Shift+Enter');
  await expect(input).toHaveValue('first line\n');
  expect(f.sends).toEqual([]);
});

test('ring_refresh_cadence_many_sessions_keeps_the_30_second_bound', async ({ page, chatCore }) => {
  test.setTimeout(120000);
  const a = chatCore.chat('many');
  const f = await fake(page);
  await openChat(page,a.id);
  await expect.poll(() => f.requests.filter((id) => id === a.id).length).toBe(1);
  await page.clock.setFixedTime(new Date());
  // Synthetic snapshot rows, not processes: visit more sessions than the old cache's capacity. Each is a copy beside the real
  // session, which stays in the snapshot (v25-shell-chrome, ticket 282: a tab whose session leaves the snapshot closes and a
  // seen session does not reopen one); the next copy replaces it, so the strip holds two tabs.
  for (let i=0;i<129;i++) {
    const id = `context-fixture-${i}`;
    f.copy(a.id,id);
    await page.locator(`.tab[data-tab="${id}"]`).click();
    await expect.poll(() => f.requests.includes(id)).toBe(true);
  }
  await page.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(ring(page)).toBeVisible();
  expect(f.requests.filter((id) => id === a.id)).toHaveLength(1);
});

test('ring_nonactive_pinned_chat_does_not_request', async ({ page, chatCore }) => {
  const [a,b] = sessions(chatCore);
  fs.writeFileSync(path.join(chatCore.home,'layout.toml'), `version = 1
locked = false
[root]
id = "centre"
split = "column"
[[root.children]]
id = "terminal"
widgets = ["terminal"]
[[root.children]]
id = "waiting"
widgets = ["waiting"]
[[root.children]]
id = "composers"
split = "row"
[[root.children.children]]
id = "composer"
widgets = ["composer"]
[[root.children.children]]
id = "pinned-composer"
widgets = ["composer@${b.id}"]
`);
  const f = await fake(page);
  await openChat(page,a.id);
  const pinned = page.locator('.composer[data-pinned]');
  await expect(pinned).toBeVisible();
  await expect.poll(() => f.requests.filter((id) => id === a.id).length).toBe(1);
  expect(f.requests.filter((id) => id === b.id)).toHaveLength(0);
  await expect(pinned.locator('.context-ring')).toHaveCount(0);
  await page.locator(`.tab[data-tab="${b.id}"]`).click();
  await expect(pinned.locator('.context-ring')).toBeVisible();
  expect(f.requests.filter((id) => id === b.id)).toHaveLength(1); // both mounted composers share one request
});

test('ring_formats_one_million_from_the_reply', async ({ page, chatCore }) => {
  const a = chatCore.chat('million');
  await fake(page, { used: 1000000, window: 1000000 });
  await openChat(page, a.id);
  await expect(ring(page)).toHaveAttribute('title', 'Context 1M / 1M');
  await expect(ring(page)).toHaveAttribute('aria-label', 'Context 1M / 1M');
});
