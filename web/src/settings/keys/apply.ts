// How a recorded or reset binding is written to the overrides: one rule for the Keyboard page and the onboarding keys step.
import { conflicts, DEFAULT_BINDINGS, type Bindings } from '../../keys';

/** A row's slots with one binding recorded: a new one is added, a slot's one replaced; a key held twice is kept once. */
export const withSlot = (slots: string[], slot: number | 'new', binding: string) => [...new Set(slot === 'new' ? [...slots, binding] : slots.map((b, i) => (i === slot ? binding : b)))];

/** The overrides with `set` written; a command in `clash` loses the bindings now `taken` (Replace). */
export function withBindings(overrides: Bindings, bindings: Bindings, set: Bindings, clash: string[], taken = Object.values(set).flat()): Bindings {
  const next: Bindings = { ...overrides, ...set };
  for (const other of clash) next[other] = (bindings[other] ?? []).filter((b) => !taken.includes(b));
  return next;
}

/** A reset of the row `id` (its commands `ids`): the defaults it takes back, and the other commands that hold one of them now. */
export function resetClash(bindings: Bindings, id: string, ids: string[]) {
  const taken = ids.flatMap((i) => DEFAULT_BINDINGS[i] ?? []);
  return { taken, clash: [...new Set(taken.flatMap((b) => conflicts(bindings, b, id)))].filter((i) => !ids.includes(i)) };
}

/** The overrides with `ids` back on their defaults; a command in `clash` loses the defaults it took. */
export function withDefaults(overrides: Bindings, bindings: Bindings, ids: string[], clash: string[], taken: string[]): Bindings {
  const next = withBindings(overrides, bindings, {}, clash, taken);
  for (const id of ids) delete next[id];
  return next;
}
