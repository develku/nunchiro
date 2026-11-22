// V2-8c: PR badge tier 2 in the window. Node side: the live chip, "Watch PR", the one-time offer and the Settings
// entry, against a fake core that stores what the real one stores (no browser, no network).
import { expect, test } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrLive } from '../src/api';
import { prAct, PrChipView, type PrChipData } from '../src/chat/PrChip';
import { makeT } from './i18n-tables';
import { LivePrStatusView } from '../src/settings/lifetime/LivePrStatus';

const URL = 'https://github.com/develku/nunchiro/pull/12';
const CHIP: PrChipData = { state: 'open', url: URL, at: '2026-10-27T11:50:00.000Z' };
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const html = (pr: PrLive | null, chip: PrChipData | null = CHIP) => renderToStaticMarkup(createElement(PrChipView, { chip, now: NOW, pr, onWatch: () => {}, onOffer: () => {}, t: makeT('en', 'en') }));
const pr = (p: Partial<PrLive>): PrLive => ({ on: false, offered: false, watched: false, live: null, hint: null, ...p });

/** The core's settings store and answers for the four ops, as `pr_live::answer` gives them. */
function fakeCore() {
  const store = { on: false, offered: false, watch: [] as string[] };
  const sent: unknown[] = [];
  return {
    store,
    sent,
    prLive(req: { op: string; url?: string; on?: boolean; offered?: boolean; front?: boolean }): Promise<PrLive> {
      sent.push(req);
      if (req.op === 'pr_live_set') {
        if (req.on !== undefined) store.on = req.on;
        if (req.offered !== undefined) store.offered = req.offered;
      }
      if (req.op === 'pr_watch' && req.url) {
        store.watch = store.watch.filter((u) => u !== req.url);
        if (req.on) store.watch.push(req.url);
      }
      const url = req.op === 'pr_live' || req.op === 'pr_watch' ? req.url : undefined;
      return Promise.resolve(pr({ on: store.on, offered: store.offered, watched: !!url && store.watch.includes(url), live: store.on && url ? { state: 'checks_fail', url } : null }));
    },
  };
}

test('pr_live_offer_once', async () => {
  // Before any answer: the offer shows next to the chip.
  expect(html(pr({}))).toContain('live PR status?');
  for (const answer of [true, false]) {
    const core = fakeCore();
    const after = await prAct(core, URL, { op: 'pr_live_set', on: answer, offered: true }, answer);
    expect(core.store.offered).toBe(true);
    expect(core.sent[0]).toEqual({ op: 'pr_live_set', on: answer, offered: true });
    // Either answer dismisses it for good: the stored flag, read back on every later chip.
    expect(html(after)).not.toContain('live PR status?');
    expect(html(await core.prLive({ op: 'pr_live', url: URL }))).not.toContain('live PR status?');
    // "Turn on" tells the core the window is in front at once.
    expect(core.sent.some((r) => (r as { op: string }).op === 'pr_front')).toBe(answer);
  }
  // Not before the core answered, and never with no chip.
  expect(html(null)).not.toContain('live PR status?');
  expect(html(pr({}), null)).toBe('');
});

test('pr_live_watch_toggles', async () => {
  // Off: no Watch button.
  expect(html(pr({ offered: true }))).not.toContain('Watch PR');
  const core = fakeCore();
  core.store.on = true;
  core.store.offered = true;
  let state = await prAct(core, URL, { op: 'pr_watch', url: URL, on: true });
  expect(state.watched).toBe(true);
  expect(html(state)).toContain('aria-pressed="true"');
  expect(html(state)).toContain('Watching');
  state = await prAct(core, URL, { op: 'pr_watch', url: URL, on: false });
  expect(state.watched).toBe(false);
  expect(html(state)).toContain('Watch PR');
  expect(core.store.watch).toEqual([]);
  // A chip whose link fails the guard gets no Watch button.
  expect(html(state, { ...CHIP, url: 'http://github.com/o/r/pull/1' })).not.toContain('Watch');
});

test('pr_live_chip_shows_state', () => {
  const live = html(pr({ on: true, offered: true, live: { state: 'merged', url: URL } }));
  expect(live).toContain('<b>Merged</b>');
  expect(live).toContain('· live');
  expect(live).toContain('data-state="merged"');
  expect(live).not.toContain('ago');
  // Tier 1 when there is no live answer, or one for another PR, or an unknown state.
  for (const p of [pr({ on: true, offered: true }), pr({ on: true, offered: true, live: { state: 'merged', url: 'https://github.com/x/y/pull/1' } }), pr({ on: true, offered: true, live: { state: '<b>x</b>', url: URL } })]) {
    const t = html(p);
    expect(t).toContain('<b>Open</b>');
    expect(t).toContain('10 min ago');
    expect(t).not.toContain('&lt;b&gt;');
  }
});

test('pr_live_settings_entry', () => {
  const view = (p: PrLive) => renderToStaticMarkup(createElement(LivePrStatusView, { t: makeT('en', 'en-US'), pr: p, onChange: () => {} }));
  const off = view(pr({ hint: 'gh was not found on PATH' }));
  expect(off).toContain('Live PR status (uses your gh)');
  expect(off).toContain('once a minute');
  expect(off).not.toContain('checked');
  expect(off).not.toContain('not found');
  const on = view(pr({ on: true, hint: 'gh was not found on PATH; live PR status needs the GitHub CLI.' }));
  expect(on).toContain('checked');
  expect(on).toContain('data-hint="livePrStatus"');
  expect(on).toContain('not found on PATH');
});
