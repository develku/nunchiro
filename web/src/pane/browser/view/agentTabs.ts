// Ticket 328 part 2: an agent space's tabs as the app reports them (`browser_tabs`, agent.rs `tabs_state`).
// `agent`: ticket 997 L7, the agent used the space in the last 20 s and the owner does not hold it.
export type AgentTabs = { tabs: { tab: number; url: string; title: string }[]; current: number; agent?: boolean };

/** The tab the pane shows. No pick is tab 1, as before the strip; a picked tab that is gone (the agent's space was forgotten,
 *  or the list shrank) falls back to the agent's current tab, else tab 1, so the slot is never left on a closed view. */
export function shownTab(list: AgentTabs, pick: number | null): number {
  const has = (n: number) => list.tabs.some((x) => x.tab === n);
  if (pick === null) return 1;
  if (has(pick)) return pick;
  return has(list.current) ? list.current : 1;
}
