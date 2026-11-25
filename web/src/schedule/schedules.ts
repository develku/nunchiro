// Ticket 993 (Schedules as a widget): the window's copy of the core's schedules, where the widget lives (the right
// sidebar or a centre tab, as the Team view: lead/team.ts) and a schedule's words: when it runs ("Weekdays 9:00 AM")
// and its next run ("in 3 hours"). The core answers every schedule request with the whole list, so one store holds it for
// the widget, the bar icon's dot and the Decisions card.
import { useEffect, useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';
import type { T } from '../i18n';
import type { Teammate } from '../lead/lead';
import { isLevel, LEVELS, ownLevel, type Level } from '../lead/level';
import { isRoomTab } from '../room/room';
import { BROWSER_TAB } from '../pane/browser/view/centreTab';
import { HIST_TAB } from '../history/history';
import { defineSetting, useFeatureSetting, writeFeature } from '../settings/useFeatureSetting';
import type { Decision } from '../types';

/** crates/nunchiro-core/src/schedule/mod.rs `Run`, `Last`, `Entry`. */
export type Run = { kind: string; project: string; label: string; model?: string; effort?: string; task?: string; teammate?: string; level?: Level };
/** `session` absent: the run could not start. `result` absent: the session still works on it. `skipped` (ticket 1002):
 *  more than 2 h late, so not run. */
export type Last = { session?: string; at: number; result?: 'finished' | 'needs_you' | 'failed' | 'skipped'; reason?: string };
/** `days`: 0 Sunday to 6 Saturday, only on a repeating one; absent is every day. `next_ms` means nothing while paused.
 *  `earlier` (ticket 1002): the runs before `last`, newest first, for the run log. */
export type Schedule = { id: string; run: Run; at: string; daily: boolean; next_ms: number; days?: number[]; paused?: boolean; last?: Last; earlier?: Last[] };

let state: Schedule[] | null = null;
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
/** One schedule request; its reply is the list every view then shows. */
export async function scheduleOp(core: CoreClient, request: { op: string; [k: string]: unknown }) {
  state = ((await core.request(request)) as { schedules: Schedule[] }).schedules;
  subs.forEach((f) => f());
}
export const refreshSchedules = (core: CoreClient): Promise<void> => scheduleOp(core, { op: 'schedule_list' }).catch(() => {}); // not connected yet, or a core without schedules: the list stays as it is
/** The list as last read, outside a render (after a request's reply). */
export const scheduleList = () => state ?? [];
/** The list as last read; null before the first read. */
export const useScheduleList = () => useSyncExternalStore(subscribe, () => state);

/** Keeps the list current for the whole window: one read when the window starts, and one whenever the core says the
 *  list changed or the socket opens again (`CoreClient.onSchedules`). Before the core sent that event the window polled:
 *  every 3 s while a run went, every 60 s while the widget was open, and on each session change. */
export function useSchedulesFeed(core: CoreClient) {
  const list = useScheduleList();
  useEffect(() => {
    void refreshSchedules(core);
    return core.onSchedules(() => void refreshSchedules(core));
  }, [core]);
  return list;
}

/** Where the widget lives: `tab` a centre tab, else the right sidebar while `open`. One choice for the window. */
export type SchedAt = { tab?: boolean; open?: boolean };
const SCHED_AT = defineSetting<SchedAt>('schedule.at', {}, (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((b) => typeof b === 'boolean') ? (v as SchedAt) : undefined));
export const useSchedAt = () => useFeatureSetting(SCHED_AT);
/** The centre tab's id. It is in no project's tab list (as a Room tab): the strip draws it while the widget lives there. */
export const SCHED_TAB = 'schedules:';
/** ⌘W on the Schedules tab: the widget goes back to the side, closed. */
export const closeSchedTab = () => writeFeature(SCHED_AT, {});
/** A tab that is a view of its own, with no session and no composer under it (the Room, Team and Schedules tabs). */
export const isViewTab = (id: string | null) => isRoomTab(id) || id === SCHED_TAB || id === BROWSER_TAB || id === HIST_TAB; // ticket 997 L1: the browser tab too; ticket 1022: History

// An ask to show the widget (the bar icon, a failed run on Home, the Settings search), with the row to open in it.
// The rails answer it (side or tab); the centre strip answers `showSchedTab` once the tab is drawn.
let wanted: string | undefined;
const asks = new Set<() => void>();
const tabAsks = new Set<() => void>();
export const openSchedules = (row?: string) => ((wanted = row), asks.forEach((f) => f()));
/** Ticket 1099: the palette's New schedule… asks for the add form instead of a row (no schedule id has a colon). */
export const NEW_SCHEDULE = 'new:';
export const onOpenSchedules = (f: () => void) => (asks.add(f), () => void asks.delete(f));
export const showSchedTab = () => tabAsks.forEach((f) => f());
export const onShowSchedTab = (f: () => void) => (tabAsks.add(f), () => void tabAsks.delete(f));
/** The row the last ask named, once. */
export const takeWanted = () => {
  const row = wanted;
  wanted = undefined;
  return row;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** A local date as the date input and the core write it. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The first day `at` (HH:MM) is still ahead: today, or tomorrow once it has passed. */
export const firstDay = (at: string) => {
  const d = new Date();
  if (`${pad(d.getHours())}:${pad(d.getMinutes())}` >= at) d.setDate(d.getDate() + 1);
  return localDay(d);
};
/** Ticket 991 C3: `HH:MM` in the system's own clock format, as the form's time box shows it (12 or 24 hours). */
export const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' '); // look 1117: never "9:00 / PM"
};
/** A stored `at`: `HH:MM` or `YYYY-MM-DD HH:MM`, as [date or '', time]. */
export const splitAt = (at: string): [string, string] => (at.includes(' ') ? (at.split(' ') as [string, string]) : ['', at]);

/** Day and month names follow the window's language; the clock follows the system (`clock`). */
const lang = () => (typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en');
/** 2023-01-01 was a Sunday: day 0. */
export const dayName = (day: number, width: 'long' | 'short' = 'long') => new Date(2023, 0, 1 + day).toLocaleDateString(lang(), { weekday: width });
const dateWords = (d: Date) => d.toLocaleDateString(lang(), { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
const timeOf = (d: Date) => clock(`${d.getHours()}:${d.getMinutes()}`);

export type Mode = 'once' | 'daily' | 'weekdays' | 'weekly';
const WEEKDAYS = [1, 2, 3, 4, 5];
/** The form's segment for a stored schedule; null for a set of days it has no segment for (an agent's "Mon, Wed, Fri"). */
export const modeOf = (s: { daily: boolean; days?: number[] }): Mode | null => {
  const days = s.days ?? [];
  return !s.daily ? 'once' : !days.length || days.length === 7 ? 'daily' : days.join() === WEEKDAYS.join() ? 'weekdays' : days.length === 1 ? 'weekly' : null;
};
/** The request's `days` for a segment. */
export const daysOf = (mode: Mode, day: number) => (mode === 'weekdays' ? WEEKDAYS : mode === 'weekly' ? [day] : undefined);

/** When it runs, in words: "Every day 9:00 PM", "Weekdays 9:00 AM", "Mondays 9:00 AM", "Mon, Wed, Fri 9:00 AM",
 *  "Once, Nov 19 9:00 AM". */
export function whenWords(t: T, s: { at: string; daily: boolean; days?: number[] }): string {
  const [day, at] = splitAt(s.at);
  const time = clock(at);
  const mode = modeOf(s);
  if (mode === 'once') return t('schedule.once', { time: day ? `${dateWords(new Date(`${day}T00:00`))} ${time}` : time });
  if (mode === 'daily') return t('schedule.daily', { time });
  if (mode === 'weekdays') return t('schedule.weekdaysAt', { time });
  if (mode === 'weekly') return t('schedule.weeklyAt', { day: dayName(s.days![0]), time });
  return `${s.days!.map((d) => dayName(d, 'short')).join(', ')} ${time}`;
}

/** A moment near now in words: "today 9:02 AM", "tomorrow 9:00 AM", else the date ("Nov 19 9:00 AM"). */
export function dayWords(t: T, ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDay(d) === localDay(new Date(now))) return t('schedule.today', { time: timeOf(d) });
  if (localDay(d) === localDay(tomorrow)) return t('schedule.tomorrow', { time: timeOf(d) });
  if (localDay(d) === localDay(yesterday)) return t('schedule.yesterday', { time: timeOf(d) });
  return `${dateWords(d)} ${timeOf(d)}`;
}

/** The next run, short and never a second time of day beside the schedule's own: "running now", "paused", "in 40 min",
 *  "in 9 hours" (under a day), "in 2 days" (under a week), else the date alone ("Dec 31, 2027"). `nextExact` has the moment. */
export function nextWords(t: T, s: Schedule, now = Date.now()): string {
  if (s.last && !s.last.result) return t('schedule.running');
  if (ranOnce(s)) return t(s.last?.result === 'failed' ? 'schedule.result.failed' : s.last?.result === 'skipped' ? 'schedule.result.skipped' : 'look8.ran'); // look v11 Home S3-1: a failed (or skipped) run never reads "ran"
  if (s.paused) return t('schedule.paused');
  const min = Math.max(1, Math.round((s.next_ms - now) / 60_000));
  if (min < 60) return t('schedule.inMin', { n: min });
  const count = (key: 'schedule.inHours' | 'schedule.inDays', n: number) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n }); // ticket 1000: "in 1 hour"
  if (min < 24 * 60) return count('schedule.inHours', Math.round(min / 60));
  if (min < 7 * 24 * 60) return count('schedule.inDays', Math.round(min / (24 * 60)));
  return dateWords(new Date(s.next_ms));
}
/** The next run's exact day and time, for the row's tooltip and its accessible text; '' while it has none. */
export const nextExact = (t: T, s: Schedule, now = Date.now()) => (s.paused || ranOnce(s) || (s.last && !s.last.result) ? '' : dayWords(t, s.next_ms, now));

/** A failed scheduled run as an owner card (eighth look, Home S2-B). The one place that reads the core's fields for it
 *  (`owner: {type: 'schedule', change: 'failed', id, run, when, place, line, reason}`; the item's `session_id` is the
 *  schedule's id too, never a session's): null for any other item. */
export const failedRunCard = (d: Decision) => (d.owner?.type === 'schedule' && d.owner.change === 'failed' ? { schedule: d.owner.id ?? '', name: d.owner.run.label || d.owner.run.kind, when: d.owner.when, reason: d.owner.reason ?? '', line: d.owner.line } : null);

/** A Once schedule that fired (eighth look, Home S2-C): the core keeps it, switched off (`paused`), with its last run,
 *  and an edit switches it on again. It reads "ran", never "paused" (which is the user's own switch: a Once entry the
 *  user paused before its time has no run at or after that time). The one place that tells the two apart. Its time is
 *  `next_ms`, which firing leaves as it was: the core's own "fired" rule (schedule/mod.rs `add_on`). A bare-time Once
 *  (the core's request takes `at: "00:34"`; the form always sends a date) has no date to read (look v10 Home S2-2). */
export function ranOnce(s: Schedule): boolean {
  if (s.daily || s.days?.length || !s.paused || !s.last) return false;
  return s.last.at >= s.next_ms;
}

/** The level a teammate's seat opens at for this run, as the core picks it (team.rs `seat_level`): a pin wins; Auto takes
 *  the asked level (none asked: standard) up to its limit; a custom model has none; a lead's seat keeps its own level
 *  (ticket 994). A teammate that is gone (its run cannot start) shows what was asked. */
export function levelOf(run: Run, mate?: Teammate): Level | undefined {
  if (!run.teammate || mate?.model) return undefined;
  if (!mate) return run.level;
  if (isLevel(mate.level) || mate.lead) return ownLevel(mate);
  const want = run.level ?? 'standard';
  return isLevel(mate.level_max) && LEVELS.indexOf(want) > LEVELS.indexOf(mate.level_max) ? mate.level_max : want;
}

/** The next run soonest first; switched-off ones (and a Once that ran) last. */
const isOff = (s: Schedule) => Number(!!s.paused || ranOnce(s));
export const sorted = (list: Schedule[]) => [...list].sort((a, b) => isOff(a) - isOff(b) || a.next_ms - b.next_ms);
/** The teammate's name, or the session's label (an unnamed one reads as its agent). */
export const nameOf = (s: { run: Run }) => s.run.label || s.run.kind;
/** Look 1117 v9 (Home S3): the task line a row shows. A row whose name and time another row shares starts its task two
 *  words before the two differ ("… "), so the part that tells them apart is not the part the ellipsis cuts. */
export function taskShown(s: Schedule, rows: Schedule[]): string {
  const line = (x: Schedule) => x.run.task?.split('\n')[0] ?? '';
  const twin = (x: Schedule) => `${nameOf(x)} ${x.at} ${x.daily} ${x.days}`;
  const words = line(s).split(' ');
  let same = 0;
  for (const o of rows) {
    if (o.id === s.id || twin(o) !== twin(s)) continue;
    const other = line(o).split(' ');
    let n = 0;
    while (n < words.length && words[n] === other[n]) n++;
    same = Math.max(same, n);
  }
  return same > 2 && same < words.length ? `… ${words.slice(same - 2).join(' ')}` : line(s);
}
