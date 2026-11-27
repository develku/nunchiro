// Ticket 993: what the Schedules specs share (schedules-993, schedules-shots-993): schedules made through the owner
// socket, as the window makes them; the widget opened from its bar icon; a schedule's last run written into the file.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { type Core, expect } from './fixtures';
import { owner } from './leader-990';

export type Last = { session?: string; at: number; result?: 'finished' | 'needs_you' | 'failed'; reason?: string };
export type Row = { id: string; run: { kind: string; project: string; label: string; model?: string; task?: string; teammate?: string; level?: string }; at: string; daily: boolean; next_ms: number; days?: number[]; paused?: boolean; last?: Last };
type Run = { kind?: string; project?: string; label?: string; model?: string; task?: string; teammate?: string; level?: string };

/** One schedule request on the owner socket; the list it answers with. */
export function sched(core: Core, request: object): Row[] {
  const reply = owner(core, request);
  if (!reply.Ok) throw new Error(`schedule request refused: ${JSON.stringify(reply)}`);
  return reply.Ok.schedules as Row[];
}
export const listed = (core: Core) => sched(core, { op: 'schedule_list' });
/** Adds one; a teammate's needs only `teammate` and `task` (the core fills the rest from the teammate). */
export const add = (core: Core, run: Run, at: string, daily = true, days?: number[]) =>
  sched(core, { op: 'schedule_add', run: { kind: 'claude', project: core.home, label: '', ...run }, at, daily, ...(days ? { days } : {}) }).at(-1)!;

/** The widget in the right sidebar, opened from its bar icon when it is not there. */
export async function openWidget(app: Page) {
  const side = app.locator('.sbar[data-widget="schedules"] .schedv');
  if (!(await side.isVisible())) {
    await app.locator('#icon-schedules').click();
    // Opening moves focus into the widget a frame later (useRails: requestAnimationFrame, then `.schedv button`). A spec
    // that focuses a row before that frame lost its focus to the Add button, and its Enter opened the form instead.
    await expect(side.locator('button').first()).toBeFocused();
  }
  await expect(side).toBeVisible();
  return side;
}
export const row = (app: Page, id: string) => app.locator(`.schedv [data-schedule="${id}"]`);

/** Writes `last` of the stored schedules (it is outside the entry's MAC) while the core is stopped, as the core writes
 *  it after a run; the restarted core loads it. `paused` is inside the MAC since wave 14 (a file edit must not switch a
 *  schedule on or off: the core refused the whole file, so these specs listed no row), so it is set through the core's
 *  own request first. `patch` is by the schedule's id. The restarted core has a new port and token: the window (opened
 *  after this) gets them. */
export async function stored(app: Page, core: Core, patch: Record<string, { last?: Last; paused?: boolean }>) {
  for (const [id, p] of Object.entries(patch)) if (p.paused !== undefined) sched(core, { op: 'schedule_pause', id, paused: p.paused });
  patch = Object.fromEntries(Object.entries(patch).map(([id, p]) => [id, p.last ? { last: p.last } : {}]));
  core.run(['serve', 'stop', '--yes'], 10_000);
  const file = path.join(core.home, 'schedules.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; schedules: Row[] };
  for (const s of all.schedules) if (patch[s.id]?.last) s.last = patch[s.id].last;
  fs.writeFileSync(file, JSON.stringify(all));
  await core.restart();
  await app.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, core.boot());
}
