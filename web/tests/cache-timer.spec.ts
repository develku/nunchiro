// Ticket 257 (G13): the prompt-cache countdown in a Claude session's tree row. The first three run the real window on a
// real core with the fake Claude (its turns from the agent hooks); the rest read the store node side, on a set clock.
import { expect, test as base } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultBars } from '../src/layout/bars';
import { openWindow, test, type Core } from './fixtures';
import { CacheTimer, cacheClockRunning, FIVE_MIN, ONE_HOUR, trackCache } from '../src/tree/CacheTimer';
import type { Session } from '../src/types';
import { makeT } from './i18n-tables';
import type { Page } from '@playwright/test';

const timer = (app: Page, id: string) => app.locator(`.row.wt2[data-hint-session="${id}"] .cache`);
async function idle(app: Page, core: Core, ttl?: number) {
  if (ttl) await app.addInitScript((v) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ features: { 'tree.cache_ttl': v } })), ttl);
  const s = core.agent(core.project('p'), 'alpha', 'x');
  await openWindow(app, {}, core);
  core.hook(s.id, 'UserPromptSubmit');
  await expect(app.locator(`.row.wt2[data-hint-session="${s.id}"]`)).toBeVisible();
  await expect(timer(app, s.id)).toHaveCount(0); // working: nothing yet
  core.hook(s.id, 'Stop');
  return s.id;
}

test('cache_timer_starts_when_claude_session_goes_idle: a turn that ends starts 5:00 in the row, counting down', async ({ app, core }) => {
  const id = await idle(app, core);
  await expect(timer(app, id)).toHaveText(/^(5:00|4:5\d)$/);
  const first = await timer(app, id).textContent();
  await expect(timer(app, id)).not.toHaveText(first!, { timeout: 3000 }); // it ticks
});

test('cache_timer_clears_when_session_works_again: a new turn takes the countdown away', async ({ app, core }) => {
  const id = await idle(app, core);
  await expect(timer(app, id)).toHaveText(/^(5:00|4:5\d)$/);
  core.hook(id, 'UserPromptSubmit');
  await expect(timer(app, id)).toHaveCount(0);
});

test('cache_timer_one_hour_setting_and_off_switch: 1 h counts from 60:00; Settings > Providers turns it off', async ({ app, core }) => {
  const id = await idle(app, core, ONE_HOUR);
  await expect(timer(app, id)).toHaveText(/^(60:00|59:5\d)$/);
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('Cache timer');
  await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: 'Cache timer · Providers' }).click();
  const sw = app.getByRole('switch', { name: 'Cache timer' });
  await expect(sw).toBeFocused();
  await expect(app.getByRole('radio', { name: '1 hour' })).toBeChecked();
  await sw.uncheck();
  await expect.poll(() => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features)).toMatchObject({ 'tree.cache_ttl': ONE_HOUR, 'tree.cache_timer': false });
  await expect(timer(app, id)).toHaveCount(0);
});

test('cache_timer_tracks_every_project_with_a_scoped_agents_view: an Agents view nested under p takes nothing from q', async ({ app, core }) => {
  // The tracking is the window's (App.tsx): a widget scoped to one project once pruned every other project's sessions.
  const p = core.project('p');
  const a = core.agent(p, 'alpha', 'x');
  const b = core.agent(core.project('q'), 'beta', 'x');
  const bars = { ...defaultBars(), nest: { [p]: ['agents'] }, open: { [`${p}::agents`]: true } };
  await app.addInitScript((v) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bars: v })), bars);
  await openWindow(app, {}, core);
  const nested = app.locator(`.sbar .tree .view[data-view="agents"] .ar[data-agent="${a.id}"]`);
  await expect(nested).toBeVisible();
  for (const s of [a, b]) core.hook(s.id, 'UserPromptSubmit');
  await expect(app.locator(`.row.wt2[data-hint-session="${b.id}"]`)).toBeVisible();
  for (const s of [a, b]) core.hook(s.id, 'Stop');
  await expect(timer(app, b.id)).toHaveText(/^(5:00|4:5\d)$/);
  await expect(nested.locator('.s .cache')).toHaveText(/^(5:00|4:5\d)$/); // the Agents line carries it too
});

// Node side: the store on a clock the test sets, and the one interval it starts, captured.
const t = makeT('en', 'en');
const T0 = 50_000_000;
const sess = (id: string, kind: Session['kind'], working: boolean, more: { state?: string; waiting?: boolean; stale?: boolean } = {}): Session =>
  ({ id, kind, project: '/p', cwd: '/p', label: id, state: more.state ?? 'running', agent_version: null, untested: false, pid: 1, pending: [], attention: { working, waiting: !!more.waiting, stale: !!more.stale, failed: false, last_activity: 0 } }) as Session;
const html = (...ids: string[]) => renderToStaticMarkup(createElement(CacheTimer, { ids, t }));
/** Runs `body` with Date.now at `clock.at` and setInterval recorded (its callbacks run when the test says). */
function clocked(body: (clock: { at: number; ticks: (() => void)[]; live: () => number }) => void) {
  const real = { now: Date.now, set: globalThis.setInterval, clear: globalThis.clearInterval };
  const clock = { at: T0, ticks: [] as (() => void)[], live: () => 0 };
  const alive = new Set<number>();
  clock.live = () => alive.size;
  Date.now = () => clock.at;
  globalThis.setInterval = ((fn: () => void) => (clock.ticks.push(fn), alive.add(clock.ticks.length), clock.ticks.length)) as unknown as typeof setInterval;
  globalThis.clearInterval = ((h: number) => void alive.delete(h)) as unknown as typeof clearInterval;
  try {
    body(clock);
  } finally {
    trackCache([], true, FIVE_MIN); // nothing left live for the next test
    Object.assign(Date, { now: real.now });
    Object.assign(globalThis, { setInterval: real.set, clearInterval: real.clear });
  }
}

base('cache_timer_shows_cache_cold_at_zero: 0:01 before the expiry, "cache cold" at it, and it stays', () =>
  clocked((clock) => {
    trackCache([sess('a', 'claude', true)], true, FIVE_MIN);
    trackCache([sess('a', 'claude', false)], true, FIVE_MIN);
    expect(html('a')).toContain('>5:00<');
    clock.at = T0 + FIVE_MIN - 1000;
    clock.ticks[0]();
    expect(html('a')).toContain('>0:01<');
    clock.at = T0 + FIVE_MIN;
    clock.ticks[0]();
    expect(html('a')).toContain('>cache cold<');
    expect(html('a')).toContain('data-cache="cold"');
    clock.at = T0 + 2 * FIVE_MIN;
    trackCache([sess('a', 'claude', false)], true, FIVE_MIN); // a later snapshot of the same idle session
    expect(html('a')).toContain('>cache cold<');
  }),
);

base('cache_timer_not_shown_for_codex_or_shell: Codex, shell and ACP sessions that stop working draw nothing', () =>
  clocked(() => {
    const kinds = ['codex', 'shell', 'acp'] as const;
    trackCache(kinds.map((k) => sess(k, k, true)), true, FIVE_MIN);
    trackCache(kinds.map((k) => sess(k, k, false)), true, FIVE_MIN);
    for (const k of kinds) expect(html(k)).toBe('');
    expect(cacheClockRunning()).toBe(false);
  }),
);

base('cache_timer_single_interval_stops_when_none_live: three idle rows share one interval; it stops when the last expires, off stops it too', () =>
  clocked((clock) => {
    const ids = ['x', 'y', 'z'];
    trackCache(ids.map((id) => sess(id, 'claude', true)), true, FIVE_MIN);
    expect(cacheClockRunning()).toBe(false); // all working: no clock
    trackCache(ids.map((id) => sess(id, 'claude', false)), true, FIVE_MIN);
    clock.at = T0 + 60_000;
    trackCache([sess('x', 'claude', false), sess('y', 'claude', false), sess('z', 'claude', true)], true, FIVE_MIN); // z works again
    trackCache(ids.map((id) => sess(id, 'claude', false)), true, FIVE_MIN); // z stops later: its own 5 min
    expect(clock.ticks).toHaveLength(1);
    expect(clock.live()).toBe(1);
    clock.at = T0 + FIVE_MIN;
    clock.ticks[0]();
    expect(clock.live()).toBe(1); // z has a minute left
    expect(html('x')).toContain('>cache cold<');
    expect(html('z')).toContain('>1:00<');
    clock.at = T0 + 60_000 + FIVE_MIN;
    clock.ticks[0]();
    expect(clock.live()).toBe(0);
    expect(cacheClockRunning()).toBe(false);
    // Turned off with a countdown live: the clock stops and the rows draw nothing.
    trackCache(ids.map((id) => sess(id, 'claude', true)), true, FIVE_MIN);
    trackCache(ids.map((id) => sess(id, 'claude', false)), true, FIVE_MIN);
    expect(clock.live()).toBe(1);
    trackCache(ids.map((id) => sess(id, 'claude', false)), false, FIVE_MIN);
    expect(clock.live()).toBe(0);
    expect(html('x')).toBe('');
  }),
);

base('cache_timer_starts_on_done_and_waiting_not_on_stale_or_closed: three starts from the ticket, two non-starts', () =>
  clocked((clock) => {
    const ids = ['done', 'wait', 'stale', 'closed'];
    trackCache(ids.map((id) => sess(id, 'claude', true)), true, FIVE_MIN);
    trackCache([sess('done', 'claude', false, { state: 'exited' }), sess('wait', 'claude', true, { waiting: true }), sess('stale', 'claude', true, { stale: true }), sess('closed', 'claude', false, { state: 'closed' })], true, FIVE_MIN);
    expect(html('done')).toContain('>5:00<'); // exited (resumable): a resume within the TTL still reads the cache
    expect(html('wait')).toContain('>5:00<');
    expect(html('stale')).toBe(''); // a stale turn is still in progress: its cache was last read 20 min ago, not now
    expect(html('closed')).toBe('');
    // A row with several sessions shows the live one closest to expiry; cold only when none is live.
    clock.at = T0 + 60_000;
    trackCache([sess('done', 'claude', false, { state: 'exited' }), sess('wait', 'claude', true), sess('stale', 'claude', true, { stale: true })], true, FIVE_MIN);
    trackCache([sess('done', 'claude', false, { state: 'exited' }), sess('wait', 'claude', false), sess('stale', 'claude', true, { stale: true })], true, FIVE_MIN);
    expect(html('stale', 'wait', 'done')).toContain('>4:00<');
    clock.at = T0 + FIVE_MIN;
    clock.ticks[0]();
    expect(html('done', 'wait')).toContain('>1:00<'); // done is cold, wait has a minute
    clock.at = T0 + 60_000 + FIVE_MIN;
    clock.ticks[0]();
    expect(html('done', 'wait')).toContain('>cache cold<');
  }),
);
