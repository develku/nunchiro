// Ticket 270 (G30, G31, G34): the values small-rows.tsx's rows edit, apart from its registrations, so the code that reads
// them (queue/notify.tsx, chrome/useTabs.ts, pr/PrView.tsx) and node-side specs import no Settings registration (review S6).
import { defineSetting } from '../settings/useFeatureSetting';

/** G30: machine alias -> alerts on; `THIS_MAC` is this Mac. A machine not in the map is on. */
export const THIS_MAC = '';
type OnMap = Record<string, boolean>;
export const ALERT_MACHINES = defineSetting<OnMap>('alerts.machines', {}, (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((b) => typeof b === 'boolean') ? (v as OnMap) : undefined,
);
/** G30: whether a session on `machine` (absent: this Mac) may raise a notification or a sound. */
export const alertsOn = (map: OnMap, machine: string | undefined) => {
  const key = machine ?? THIS_MAC;
  return !(Object.hasOwn(map, key) && map[key] === false);
};

/** G31: the order next/previous session walks; the keys stay the same (needs 166). */
export type CycleOrder = 'strip' | 'mru';
export const CYCLE_ORDER = defineSetting<CycleOrder>('tabs.cycle_order', 'strip', (v) => (v === 'strip' || v === 'mru' ? v : undefined));

/** G34: the core key; off by default. */
export const STRIP_CREDITS = 'pr.strip_agent_credits';

/** The search fields small-rows.tsx registers, one section each. */
export const SMALL_ROWS_FIELDS = {
  alerts: { key: 'alertMachines', at: '[data-setting="alertMachines"]' },
  keys: { key: 'tabCycleOrder', at: '[data-setting="tabCycleOrder"]:checked' },
  git: { key: 'stripAgentCredits', at: '[data-setting="stripAgentCredits"]' },
} as const;
