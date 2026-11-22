// V2.5-54 follow-up (A22): the once-only strip cleanup is marked done only after its write succeeds, tries once per load.
// Pure: no page, a map-backed localStorage stub.
import { expect, test } from '@playwright/test';
import { LayoutStore, count } from '../src/layout/store';
import { type Layout } from '../src/layout/model';

const KEY = 'nunchiro.layout.strip-left-chat.v1';
const withStrip = (): Layout => ({
  version: 1,
  root: {
    id: 'main',
    split: 'column',
    children: [
      { id: 'terminal', widgets: ['terminal'] },
      { id: 'waiting', widgets: ['waiting'] },
      { id: 'composer', widgets: ['composer'] },
    ],
  },
});
const install = () => {
  const m = new Map<string, string>();
  const stub = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true });
  return m;
};
test.afterEach(() => void Reflect.deleteProperty(globalThis, 'localStorage'));
const tick = () => new Promise((r) => setTimeout(r, 0));

test('strip_step_marked_after_write_succeeds', async () => {
  const m = install();
  const saved: Layout[] = [];
  let release!: () => void;
  const s = new LayoutStore((l) => { saved.push(l); return new Promise<void>((r) => (release = r)); });
  s.fromFile({ layout: withStrip(), error: null });
  expect(m.get(KEY)).not.toBe('1'); // still writing: not marked yet
  release();
  await tick();
  expect(m.get(KEY)).toBe('1');
  expect(saved).toHaveLength(1);
  expect(count(saved[0], 'waiting')).toBe(0);
});

test('strip_step_not_marked_when_write_fails', async () => {
  const m = install();
  const s = new LayoutStore(() => Promise.reject(new Error('disk')));
  s.fromFile({ layout: withStrip(), error: null });
  await tick();
  expect(m.get(KEY)).not.toBe('1');
  let calls = 0;
  const s2 = new LayoutStore(async () => void calls++);
  s2.fromFile({ layout: withStrip(), error: null });
  await tick();
  expect(calls).toBe(1);
  expect(m.get(KEY)).toBe('1');
});

test('strip_step_marked_when_nothing_to_drop', async () => {
  const m = install();
  let calls = 0;
  const s = new LayoutStore(async () => void calls++);
  s.fromFile({ layout: null, error: null });
  expect(m.get(KEY)).toBe('1');
  expect(calls).toBe(0);
});

test('strip_step_one_attempt_per_load', async () => {
  install();
  let calls = 0;
  let release!: () => void;
  const s = new LayoutStore(() => { calls++; return new Promise<void>((r) => (release = r)); });
  s.fromFile({ layout: withStrip(), error: null });
  s.fromFile({ layout: withStrip(), error: null });
  expect(calls).toBe(1);
  release();
  await tick();
  expect(calls).toBe(1);
});

