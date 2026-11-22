// ChatFeed against a fake core socket (Node side, no browser): the core's per-socket limits and close timing.
import { expect, test } from '@playwright/test';
import { ChatFeed, type Page } from '../src/chat/feed';

const MAX_WATCHES = 64; // crates/nunchiro-core/src/http/mod.rs

const page = (end: number): Page => ({ schema_version: 1, generation: 1, events: [], before: null, end, banner: null, skipped: 0 });

/** One fake `/ws` connection: it keeps the core's chat watch set and its 64-per-socket cap. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];
  /** Open new sockets as soon as they are made (false: the test opens or fails them). */
  static auto = true;
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  watched = new Set<string>();
  private openers: (() => void)[] = [];
  constructor() {
    FakeSocket.all.push(this);
    if (FakeSocket.auto) queueMicrotask(() => this.open());
  }
  addEventListener(type: string, f: () => void) {
    if (type === 'open') this.openers.push(f);
  }
  removeEventListener(type: string, f: () => void) {
    if (type === 'open') this.openers = this.openers.filter((x) => x !== f);
  }
  open() {
    if (this.readyState !== FakeSocket.CONNECTING) return;
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.openers.splice(0).forEach((f) => f());
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.watched.clear();
    queueMicrotask(() => this.onclose?.());
  }
  send(raw: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send on a socket that is not open');
    const f = JSON.parse(raw) as { id: number; chat: string; before?: number };
    let response: object;
    if (f.before === undefined && !this.watched.has(f.chat) && this.watched.size >= MAX_WATCHES) response = { Err: 'too many watched chat sessions' };
    else {
      if (f.before === undefined) this.watched.add(f.chat);
      response = { Ok: { type: 'chat_page', session: f.chat, page: page(f.before ?? 1) } };
    }
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: f.id, response }) }));
  }
  push(session: string) {
    this.onmessage?.({ data: JSON.stringify({ event: 'chat', session, page: page(2) }) });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const real = (globalThis as { WebSocket?: unknown }).WebSocket;
test.beforeEach(() => {
  FakeSocket.all = [];
  FakeSocket.auto = true;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
  // feed.ts reads window.__NUNCHIRO__ on each connect (ticket 620); Node has no window, so give it an empty one.
  (globalThis as { window?: unknown }).window = {};
});
test.afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = real;
  delete (globalThis as { window?: unknown }).window;
});

test('feed: 80 sessions opened and closed one after another never reach the core watch cap; the 81st still updates', async () => {
  const feed = new ChatFeed({ port: 1, token: 't' });
  for (let i = 0; i < 80; i++) {
    const got: string[] = [];
    const off = feed.open(`s${i}`, { page: (_p, kind) => got.push(kind), error: (e) => got.push(`error: ${e}`) });
    await tick();
    expect(got, `session ${i}`).toEqual(['open']);
    off();
  }
  const got: string[] = [];
  feed.open('s80', { page: (_p, kind) => got.push(kind), error: (e) => got.push(`error: ${e}`) });
  await tick();
  const live = FakeSocket.all.filter((s) => s.readyState === FakeSocket.OPEN);
  expect(live).toHaveLength(1);
  live[0].push('s80');
  expect(got).toEqual(['open', 'live']);
  expect(live[0].watched.size).toBeLessThanOrEqual(MAX_WATCHES);
});

test('feed: tabs that stay open keep their live updates across the socket being replaced', async () => {
  const feed = new ChatFeed({ port: 1, token: 't' });
  const kept: string[] = [];
  feed.open('kept', { page: (_p, kind) => kept.push(kind), error: (e) => kept.push(`error: ${e}`) });
  await tick();
  for (let i = 0; i < 100; i++) {
    const off = feed.open(`x${i}`, { page: () => {}, error: (e) => kept.push(`error x${i}: ${e}`) });
    await tick();
    off();
  }
  const live = FakeSocket.all.filter((s) => s.readyState === FakeSocket.OPEN);
  expect(live).toHaveLength(1);
  expect(live[0].watched.has('kept')).toBe(true);
  live[0].push('kept');
  expect(kept.filter((k) => k.startsWith('error'))).toEqual([]);
  expect(kept.at(-1)).toBe('live');
});

test('feed: a socket that closes while connecting rejects a queued older() and a later older() works', async () => {
  FakeSocket.auto = false;
  const feed = new ChatFeed({ port: 1, token: 't' });
  feed.open('a', { page: () => {}, error: () => {} });
  const queued = feed.older('a', 5);
  FakeSocket.all[0].close();
  const settled = await Promise.race([queued.then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), 200))]);
  expect(settled).toBe('rejected');
  FakeSocket.auto = true;
  await expect.poll(() => FakeSocket.all.some((s) => s.readyState === FakeSocket.OPEN), { timeout: 3000 }).toBe(true);
  await expect(feed.older('a', 5)).resolves.toMatchObject({ end: 5 });
});

test('feed: with 50 tabs kept open, opening and closing more does not reopen the socket each time', async () => {
  const feed = new ChatFeed({ port: 1, token: 't' });
  for (let i = 0; i < 50; i++) feed.open(`keep${i}`, { page: () => {}, error: () => {} });
  await tick();
  const before = FakeSocket.all.length;
  for (let i = 0; i < 10; i++) {
    const off = feed.open(`y${i}`, { page: () => {}, error: () => {} });
    await tick();
    off();
  }
  expect(FakeSocket.all.length - before).toBeLessThanOrEqual(1);
});
