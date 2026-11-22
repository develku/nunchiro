// Ticket 1022 (mockup docs/design/tree-done-1121, section 3): where the History widget lives (the right sidebar or a
// centre tab, as Schedules: schedule/schedules.ts) and the asks that reach it from the tree's history count.
import { defineSetting, useFeatureSetting, writeFeature } from '../settings/useFeatureSetting';
import type { Session } from '../types';

/** `tab` a centre tab, else the right sidebar while `open`. One choice for the window. */
export type HistAt = { tab?: boolean; open?: boolean };
const HIST_AT = defineSetting<HistAt>('history.at', {}, (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((b) => typeof b === 'boolean') ? (v as HistAt) : undefined));
export const useHistAt = () => useFeatureSetting(HIST_AT);
/** The centre tab's id; in no project's tab list (as the Schedules tab). */
export const HIST_TAB = 'history:';
/** ⌘W on the History tab: the widget goes back to the side, closed. */
export const closeHistTab = () => writeFeature(HIST_AT, {});

type Fn<A extends unknown[] = []> = (...a: A) => void;
const on = <A extends unknown[]>(set: Set<Fn<A>>) => (f: Fn<A>) => (set.add(f), () => void set.delete(f));

// An ask to show the widget (the bar icon, "View all in History"), with the project to filter by. The rails answer it
// (side or tab); the centre strip answers `showHistTab` once the tab is drawn; the view takes the project.
let wanted: string | undefined;
const asks = new Set<Fn>();
const tabAsks = new Set<Fn>();
const continues = new Set<Fn<[Session]>>();
export const openHistory = (project?: string) => ((wanted = project), asks.forEach((f) => f()));
export const onOpenHistory = on(asks);
export const showHistTab = () => tabAsks.forEach((f) => f());
export const onShowHistTab = on(tabAsks);
/** The project the last ask named, once ('' for all). */
export const takeWanted = () => {
  const p = wanted;
  wanted = undefined;
  return p;
};
/** "Continue": the window's resume (chrome/useTabs.ts), which App registers. */
export const continueSession = (s: Session) => continues.forEach((f) => f(s));
export const onContinue = on(continues);
