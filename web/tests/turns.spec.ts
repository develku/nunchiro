// Needs 170 (2): turn_end_helper. Pure functions of web/src/queue/turns.ts, no page; `document` is a two-field stand-in.
import { expect, test } from '@playwright/test';
import { failures, isChild, isViewed, turnEnds } from '../src/queue/turns';
import type { Session } from '../src/types';

const session = (id: string, over: Partial<Session> = {}, attention: Partial<Session['attention']> = {}): Session =>
  ({
    id, kind: 'claude', project: '/p', cwd: '/p', label: id, state: 'running', agent_version: null, untested: false, pid: 1, pending: [],
    attention: { working: false, waiting: false, stale: false, failed: false, last_activity: 0, ...attention }, ...over,
  }) as Session;
const was = (...ids: string[]) => new Map(ids.map((i) => [i, true]));

test('a true-to-false working on a running session ends a turn', () => {
  expect(turnEnds(was('a', 'b'), [session('a'), session('b', {}, { working: true })])).toEqual(['a']);
});

test('first sight is not an end, and a session still working or already idle is not one either', () => {
  expect(turnEnds(new Map(), [session('a')])).toEqual([]);
  expect(turnEnds(new Map([['a', false]]), [session('a')])).toEqual([]);
  expect(turnEnds(was('a'), [session('a', {}, { working: true })])).toEqual([]);
});

test('an exited, waiting or failed session is not a turn end', () => {
  const waiting = session('w', { pending: [{ id: 'd', kind: 'permission' } as Session['pending'][number]] });
  const exited = session('e', { state: 'exited' });
  const failed = session('f', { state: 'failed' });
  expect(turnEnds(was('w', 'e', 'f'), [waiting, exited, failed])).toEqual([]);
});

test('a side_chat session is a child', () => {
  expect(isChild(session('s', { side_chat: true }))).toBe(true);
  expect(isChild(session('s'))).toBe(false);
});

test('isViewed is false when the window is unfocused, hidden, or the id is not current', () => {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  const doc = (focus: boolean, vis: string) => (g.document = { hasFocus: () => focus, visibilityState: vis });
  try {
    doc(true, 'visible');
    expect(isViewed('a', 'a')).toBe(true);
    expect(isViewed('a', 'b')).toBe(false);
    expect(isViewed('a', null)).toBe(false);
    doc(false, 'visible');
    expect(isViewed('a', 'a')).toBe(false);
    doc(true, 'hidden');
    expect(isViewed('a', 'a')).toBe(false);
  } finally {
    g.document = before;
  }
});

test('ticket 372: a seen session turning failed is a failure; a first sight or one already failed is not', () => {
  const seen = new Map([['a', 'working'], ['b', 'idle'], ['c', 'failed']]);
  const crashed = session('a', { state: 'failed' });
  const carded = session('b', { problem: { case: 'unexpected', cause: 'agent text' } });
  const still = session('c', { state: 'failed' });
  const fresh = session('d', { state: 'failed' });
  expect(failures(seen, [crashed, carded, still, fresh])).toEqual(['a', 'b']);
  expect(failures(seen, [session('a'), session('b')])).toEqual([]);
});
