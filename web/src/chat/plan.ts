// needs 168: a session's newest plan (Claude `TodoWrite`, Codex `update_plan`), read from the chat events already loaded.
// Same rule as crates/nunchiro-core/src/chat/handoff.rs: the newest list replaces the older one, an empty list clears it,
// a call whose list is not an array is ignored. Pure; the text is the agent's and is only ever drawn as text.
import type { ChatEvent } from './feed';

export type Status = 'pending' | 'in_progress' | 'completed';
/** `active` is Claude's present-tense form of the step (`activeForm`), shown while the step is in progress. */
export interface PlanItem {
  text: string;
  status: Status;
  active?: string;
}
export interface Plan {
  items: PlanItem[];
}

const LIST: Record<string, { key: string; text: string }> = {
  TodoWrite: { key: 'todos', text: 'content' },
  update_plan: { key: 'plan', text: 'step' },
};

const status = (s: unknown): Status => (s === 'completed' || s === 'in_progress' ? s : 'pending');

function items(list: unknown[], text: string): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o[text] !== 'string' || !o[text]) continue;
    out.push({ text: o[text] as string, status: status(o.status), ...(typeof o.activeForm === 'string' && o.activeForm ? { active: o.activeForm } : {}) });
  }
  return out;
}

/** The plan of the newest plan call in `events`, or null (no call, an empty newest list, or nothing readable). */
export function planOf(events: ChatEvent[]): Plan | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const d = events[i].data;
    if (d.kind !== 'tool_use') continue;
    const shape = Object.hasOwn(LIST, d.name) ? LIST[d.name] : undefined;
    const input = d.input as Record<string, unknown> | null | undefined;
    const list = shape && input && typeof input === 'object' ? input[shape.key] : undefined;
    if (!shape || !Array.isArray(list)) continue; // malformed: the previous plan stands
    const found = items(list, shape.text);
    return found.length ? { items: found } : null;
  }
  return null;
}

/** The step to show on the folded line: the one in progress (its `activeForm` when Claude gave one), else the first pending, else null. */
export function current(plan: Plan): string | null {
  const it = plan.items.find((x) => x.status === 'in_progress');
  if (it) return it.active ?? it.text;
  return plan.items.find((x) => x.status === 'pending')?.text ?? null;
}

export const tally = (plan: Plan) => ({ done: plan.items.filter((x) => x.status === 'completed').length, total: plan.items.length });
