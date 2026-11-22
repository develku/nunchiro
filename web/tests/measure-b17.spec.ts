// B17 (look 1117, S2): "Open file from Diff" and "View in Diff" were never measured. Press to result in the page's own clock
// (a capture listener on the press, a MutationObserver until the result is in the DOM), 30 repeats each; p95 under 100 ms.
// w116: measured to the DOM update, not to a drawn frame: macOS fires headless Chromium's 16 ms frame timers ~130 ms late
// (frame p95 114-146 ms on main and on 7f58d06a0, a blank page too) while the app's update lands in ~5 ms.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { mockupTurn } from './fixtures/fidelity-chat/turn';

const RUNS = 30;
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
/** Nightly 11-21: on a loaded machine (web-smoke.sh's rule: 1-minute load at WEB_SMOKE_LOAD_MAX, default 15, or more) the
 *  press-to-frame time measures the machine, not the app: the p95 is still printed, the 100 ms budget is not asserted. */
function underBudget(ms: number) {
  const load = os.loadavg()[0];
  if (load >= Number(process.env.WEB_SMOKE_LOAD_MAX ?? 15)) return void test.info().annotations.push({ type: 'budget skipped', description: `load ${load.toFixed(1)}, p95 ${ms.toFixed(1)} ms` });
  expect(ms).toBeLessThan(100);
}

/** Clicks `target` and resolves the ms from the press to the DOM update that puts `done` (a selector) in the page. */
async function timed(page: Page, target: Locator, done: string) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __took: Promise<number> };
    w.__took = new Promise((resolve) => {
      addEventListener('pointerdown', () => {
        const t0 = performance.now();
        const check = () => !!document.querySelector(sel) && (resolve(performance.now() - t0), ob.disconnect(), true);
        const ob = new MutationObserver(check);
        if (!check()) ob.observe(document, { subtree: true, childList: true, attributes: true });
      }, { capture: true, once: true });
    });
  }, done);
  await target.click();
  return page.evaluate(() => (window as unknown as { __took: Promise<number> }).__took);
}

test('B17 open_file_from_diff_p95_under_100ms', async ({ app, core }) => {
  const dir = core.project('measure');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const s = core.shell(dir, 'measure');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  await openWindow(app);
  await app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true }).click();
  const tab = app.locator(`.tab[data-tab="file:${s.id}:a.txt"]`);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    await app.getByRole('list', { name: 'Changed files' }).locator('[data-path]').filter({ hasText: 'a.txt' }).click();
    const open = app.getByRole('region', { name: 'Diff of a.txt' }).getByRole('button', { name: 'Open file' });
    times.push(await timed(app, open, `.tab[data-tab="file:${s.id}:a.txt"][aria-selected="true"]`));
    await expect(tab).toHaveCount(1);
  }
  console.log(`B17 open file from Diff ${test.info().project.name}: p50 ${[...times].sort((a, b) => a - b)[14].toFixed(1)} ms, p95 ${p95(times).toFixed(1)} ms`);
  underBudget(p95(times));
});

chatTest('B17 view_in_diff_p95_under_100ms', async ({ page, chatCore }) => {
  const s = chatCore.chat('measure');
  mockupTurn(s.file, s.cwd);
  append(s.file, rec.user('again'));
  await openChat(page, s.id);
  const btn = chat(page, s.id).locator('.chcard').getByRole('button', { name: 'View in Diff' }).first();
  const diffIcon = page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Diff', exact: true });
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    times.push(await timed(page, btn, '.sbar[data-widget="diff"] .diff'));
    await diffIcon.click(); // closes the widget for the next press
    await expect(page.locator('.sbar[data-widget="diff"]')).toHaveCount(0);
  }
  console.log(`B17 View in Diff ${chatTest.info().project.name}: p50 ${[...times].sort((a, b) => a - b)[14].toFixed(1)} ms, p95 ${p95(times).toFixed(1)} ms`);
  underBudget(p95(times));
});