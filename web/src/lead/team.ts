// Ticket 990 (owner 11-17, docs/design/leader-room/team-widget-1117.html "1 + 4"): where a place's Team view lives. One view,
// one place at a time: the right sidebar (default, closed until opened) or a centre tab. Kept per place (a project folder,
// or '' for Home), as the "Show room" switch was.
import { currentFeature, defineSetting, useFeatureSetting, writeFeature } from '../settings/useFeatureSetting';

export type TeamAt = { tab?: boolean; open?: boolean };
const TEAM_AT = defineSetting<Record<string, TeamAt>>('lead.team', {}, (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x && typeof x === 'object' && Object.values(x).every((b) => typeof b === 'boolean')) ? (v as Record<string, TeamAt>) : undefined,
);

/** The place's choice and how to change it; a null place (no lead) reads closed and changes nothing. */
export function useTeamAt(place: string | null): [TeamAt, (next: TeamAt) => void] {
  const [all, set] = useFeatureSetting(TEAM_AT);
  return [place === null ? {} : (all[place] ?? {}), (next) => place !== null && set({ ...all, [place]: next })];
}

// The centre strip owns the active tab; a press elsewhere (the header chip, the bar icon, "Open as a tab") asks it to show
// the Team tab of a room folder.
const tabAsks = new Set<(folder: string) => void>();
export const showTeamTab = (folder: string) => tabAsks.forEach((f) => f(folder));
export const onShowTeamTab = (f: (folder: string) => void) => (tabAsks.add(f), () => void tabAsks.delete(f));
/** ⌘W or the x on the Team tab: the place's Team view goes back to the side, closed (as Schedules and History). */
export const closeTeamTab = (place: string) => writeFeature(TEAM_AT, { ...currentFeature(TEAM_AT), [place]: {} });
/** "Open as a tab" from outside a component (the palette, look 1117 v11-A-S3-1): moves the place's Team view to a tab and shows it. */
export const teamToTab = (place: string, folder: string) => (writeFeature(TEAM_AT, { ...currentFeature(TEAM_AT), [place]: { tab: true } }), showTeamTab(folder));

/** Puts focus in the side's Team view (a press on the chip while it is already open still shows where it is). */
export const focusTeam = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('.teamv [role="tab"][aria-selected="true"], .teamv button')?.focus());
