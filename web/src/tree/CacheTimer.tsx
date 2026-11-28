// Ticket 257 (G13; needs 197; peer O-020, O-021): the prompt-cache countdown in a Claude session's tree row. When the
// window sees a Claude session stop working (idle, done or waiting), its row's meta slot counts down to the cache's
// expiry (`4:59`) and then reads "cache cold"; it clears when the session works again. Codex, shells and ACP agents never
// show it. One 1 s interval drives every row, and only while at least one countdown is live.
// The countdown's format (whole seconds rounded up, `m:ss`) and the two durations after Orca's
// src/renderer/src/components/sidebar/CacheTimer.tsx and settings/AgentCacheTimerSection.tsx,
// MIT License, Copyright (c) 2026 Lovecast Inc. (behaviour and format only; theirs are a zustand store and Radix parts).
import { useEffect, useSyncExternalStore } from 'react';
import type { T } from '../i18n';
import { defineSetting, useFeatureSetting } from '../settings/useFeatureSetting';
import { status, type Session } from '../types';

export const FIVE_MIN = 5 * 60_000;
export const ONE_HOUR = 60 * 60_000;
/** On by default (Orca's default); the Settings > Agents section (features/cache-timer.tsx) edits both. */
export const CACHE_TIMER = defineSetting<boolean>('tree.cache_timer', true, (v) => (typeof v === 'boolean' ? v : undefined));
export const CACHE_TTL = defineSetting<number>('tree.cache_ttl', FIVE_MIN, (v) => (v === FIVE_MIN || v === ONE_HOUR ? v : undefined));

// shortcut: the countdown starts at the stop this window saw, not at the transcript's last response, so a window
// opened (or restarted) on an already idle session shows nothing; read the transcript's time if owners ask for it.
const stopped = new Map<string, number>(); // session id -> when the window saw it stop working
const wasWorking = new Map<string, boolean>();
const turns = new Map<string, number>(); // session id -> its finished-turn count (`completion_seq`) at the last update
let now = Date.now();
let clock: ReturnType<typeof setInterval> | 0 = 0;
let ttl = FIVE_MIN;
let on = true;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
const notify = () => listeners.forEach((l) => l());
const anyLive = () => on && [...stopped.values()].some((at) => now - at < ttl);

function tick() {
  now = Date.now();
  notify(); // the tick that reaches zero draws "cache cold" before the clock stops
  if (!anyLive()) stop();
}
const stop = () => (clearInterval(clock), (clock = 0));

/** Reads the sessions' transitions; App calls it with the window's whole list (rows read the store by id). */
export function trackCache(sessions: Session[], enabled: boolean, ms: number) {
  const ids = new Set(sessions.map((s) => s.id));
  for (const id of [...wasWorking.keys()]) if (!ids.has(id)) (wasWorking.delete(id), stopped.delete(id), turns.delete(id));
  for (const s of sessions) {
    if (s.kind !== 'claude') continue;
    const st = status(s);
    const working = st === 'working' || st === 'stale'; // stale is a turn still in progress, only silent for 20 min
    // A done (exited, resumable) session keeps counting: a resume within the TTL still reads the cache.
    // A turn shorter than one update is never seen working: its finished-turn count still grows.
    const seq = s.completion_seq ?? 0;
    const before = turns.get(s.id);
    if (working || s.state === 'closed') stopped.delete(s.id);
    else if (wasWorking.get(s.id) || (before !== undefined && seq > before)) stopped.set(s.id, Date.now());
    wasWorking.set(s.id, working);
    turns.set(s.id, seq);
  }
  on = enabled;
  ttl = ms;
  now = Date.now();
  notify();
  if (anyLive() && !clock) clock = setInterval(tick, 1000);
  if (!anyLive() && clock) stop();
}

/** The window's one call (App.tsx): tracks every session with the window's settings. */
export function useCacheTrack(sessions: Session[]) {
  const [enabled] = useFeatureSetting(CACHE_TIMER);
  const [ms] = useFeatureSetting(CACHE_TTL);
  useEffect(() => trackCache(sessions, enabled, ms), [sessions, enabled, ms]);
}

/** Whether the one clock runs (cache-timer.spec.ts `cache_timer_single_interval_stops_when_none_live`). */
export const cacheClockRunning = () => clock !== 0;

/** `4:59` from whole seconds left. */
export const countdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Whole seconds left (rounded up, as Orca's) for the row's sessions: the live one closest to expiry, else 0 (cold) if
 *  one stopped, else undefined. A number, so a tick that changes nothing for a row does not re-render it. */
function secsLeft(ids: string[]) {
  if (!on) return undefined;
  let best: number | undefined;
  for (const id of ids) {
    const at = stopped.get(id);
    if (at === undefined) continue;
    const s = Math.ceil(Math.max(0, ttl - (now - at)) / 1000);
    if (best === undefined || (s > 0 && (best === 0 || s < best))) best = s;
  }
  return best;
}

/** The row's meta slot: nothing unless one of these Claude sessions stopped working while the window watched. */
export function CacheTimer({ ids, t }: { ids: string[]; t: T }) {
  const read = () => secsLeft(ids);
  const left = useSyncExternalStore(subscribe, read, read);
  if (left === undefined) return null;
  const text = left ? countdown(left) : t('cacheTimer.cold');
  return (
    <span className="tm cache" data-cache={left ? 'warm' : 'cold'} title={left ? t('cacheTimer.tip', { left: text }) : t('cacheTimer.coldTip')}>
      {text}
    </span>
  );
}
