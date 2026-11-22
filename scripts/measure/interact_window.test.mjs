// The in-window driver's timing (interact_window.js makeProbe) on a fake clock: frames every 16 ms, the posted task
// 2 ms after its frame. Run: node --test scripts/measure/interact_window.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const makeProbe = vm.runInNewContext(`${fs.readFileSync(new URL('./interact_window.js', import.meta.url), 'utf8')}; makeProbe`, {});

function rig(shownAt) {
  let clock = 1000, frames = [], tasks = [], timers = [];
  const env = {
    now: () => clock,
    raf: (f) => frames.push(f),
    post: (f) => tasks.push(f),
    after: (ms, f) => { const t = { at: clock + ms, f }; timers.push(t); return () => { timers = timers.filter((x) => x !== t); }; },
    holds: () => clock >= shownAt,
  };
  const step = () => {
    clock += 16;
    const run = frames; frames = [];
    run.forEach((f) => f(clock));
    clock += 2;
    const posted = tasks; tasks = [];
    posted.forEach((f) => f());
    const due = timers.filter((t) => t.at <= clock); timers = timers.filter((t) => t.at > clock);
    due.forEach((t) => t.f());
  };
  return { env, step, at: () => clock };
}

test('time runs from the press to the end of the first frame that shows the result', async () => {
  const r = rig(1050); // shown from clock 1050: the frame at 1052 is the first that holds
  const p = makeProbe(r.env);
  const done = p.arm({});
  p.start(999); // the press: its event stamp, just before now()
  for (let i = 0; i < 5; i++) r.step();
  // frames at 1016, 1034, 1052 (holds); its task at 1054
  assert.equal(await done, 1054 - 999);
});

test('a result already on screen before the press does not stop the clock until the press', async () => {
  const r = rig(0);
  const p = makeProbe(r.env);
  const done = p.arm({});
  r.step(); r.step(); // shown, but no press yet
  p.start(r.at());
  const t0 = r.at();
  r.step();
  assert.equal(await done, 18);
  assert.equal(t0 + 18, r.at());
});

test('only the first press counts; a stamp from another clock falls back to now(); a miss is null', async () => {
  const r = rig(Infinity);
  const p = makeProbe({ ...r.env, miss: 100 });
  const done = p.arm({});
  p.start(Date.now() * 10); // not on the performance clock
  const t0 = r.at();
  p.start(t0 + 5);
  assert.equal(p.t0, t0);
  for (let i = 0; i < 10; i++) r.step();
  assert.equal(await done, null);
  assert.equal(p.armed, false);
});
