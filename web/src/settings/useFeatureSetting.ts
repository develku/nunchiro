// Feature setting values (ticket 250; needs 197): what an absorb feature stores without editing settings.ts, api.rs or
// quit_settings. The contract (read with features/registry.ts):
// - Window value: `const K = defineSetting(key, fallback, clean)` once at module level, then `useFeatureSetting(K)`
//   returns `[value, set]` anywhere in the window. Stored per window in `Settings.features[key]`. A missing value, or one
//   `clean` rejects (returns undefined or throws), reads as `fallback`, key by key: one broken key never spoils another
//   (the store's "never partially trusted" rule). `set` stores only a value `clean` accepts. A key is defined once.
// - Core value: `useCoreFeature(key, fallback)` returns `[value, set, error]` inside a Settings page or section; it reads
//   and writes the core's `settings.json` `features` over the owner-only `quit_settings` op. `set(null)` removes the key;
//   `set` resolves to whether the core took the write.
//   The core refuses a key outside `^[a-z0-9]+(\.[a-z0-9_]+)+$` or a value over 4096 bytes serialised (the error comes
//   back in `error`, nothing is written); core readers call `Settings::feature::<T>(key)`.
// Typed definitions after T3 Code's settings model (a schema per key, a lenient decode that falls back per key):
// t3code/packages/shared/src/serverSettings.ts, MIT License, Copyright (c) 2026 T3 Tools Inc. (idea only; no code taken).
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';
import { rawError } from '../errors';

/** A defined key; the type parameter carries the value's type to `useFeatureSetting`. */
export type FeatureKey<T> = string & { readonly __value?: T };
type Def = { fallback: unknown; clean: (v: unknown) => unknown };

/** The key rule the core enforces for its values, used for window keys too so one key can move between the two. */
export const FEATURE_KEY = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const defs = new Map<string, Def>();

export function defineSetting<T>(key: string, fallback: T, clean: (v: unknown) => T | undefined): FeatureKey<T> {
  if (!FEATURE_KEY.test(key)) throw new Error(`Feature setting key "${key}" must be dotted lowercase, like terminal.scrollback_lines`);
  if (defs.has(key)) throw new Error(`Feature setting "${key}" is already defined`);
  defs.set(key, { fallback, clean });
  return key as FeatureKey<T>;
}

/** The value of `key` in a stored features map: `clean`'s result, or `fallback` when it is absent or rejected. */
export function readFeature<T>(features: Record<string, unknown>, key: string, fallback: T, clean: (v: unknown) => T | undefined): T {
  if (!Object.hasOwn(features, key)) return fallback;
  try {
    return clean(features[key]) ?? fallback;
  } catch {
    return fallback;
  }
}

// The window store's `features`, mirrored here so a hook outside Settings reads it (useAppSettings feeds it).
let store: { features: Record<string, unknown>; write: (key: string, v: unknown) => void } = { features: {}, write: () => {} };
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** useAppSettings: the stored map and how to write one key; `notify` is false for the first, before anything drew. */
export function publishFeatures(features: Record<string, unknown>, write: (key: string, v: unknown) => void, notify = true) {
  if (store.features === features && store.write === write) return;
  store = { features, write };
  if (notify) listeners.forEach((l) => l());
}

export function useFeatureSetting<T>(key: FeatureKey<T>): [T, (v: T) => void] {
  const def = defs.get(key);
  if (!def) throw new Error(`Feature setting "${key}" is not defined (call defineSetting first)`);
  const features = useSyncExternalStore(subscribe, () => store.features);
  const clean = def.clean as (v: unknown) => T | undefined;
  const value = readFeature(features, key, def.fallback as T, clean);
  const set = useCallback(
    (v: T) => {
      if (readFeature({ [key]: v }, key, undefined, clean) !== undefined) store.write(key, v);
    },
    [key, clean],
  );
  return [value, set];
}

/** The value of `key` right now, for a callback that outlives the render it was made in (an undo). */
export function currentFeature<T>(key: FeatureKey<T>): T {
  const def = defs.get(key)!;
  return readFeature(store.features, key, def.fallback as T, def.clean as (v: unknown) => T | undefined);
}

/** Writes `key` from outside a component (a palette command); as the hook's `set`, only a value `clean` accepts. */
export function writeFeature<T>(key: FeatureKey<T>, v: T) {
  const def = defs.get(key)!;
  if (readFeature({ [key]: v }, key, undefined, def.clean as (v: unknown) => T | undefined) !== undefined) store.write(key, v);
}

/** SettingsView provides the core client to its pages and sections; useCoreFeature reads it. */
export const CoreFeatureClient = createContext<CoreClient | null>(null);

type Reply = { settings: { features?: Record<string, unknown> } };
/** A stored value of another JSON type than the fallback reads as the fallback (the core's `feature::<T>` is `None` too). */
const sameType = (v: unknown, fallback: unknown) => v !== undefined && v !== null && Array.isArray(v) === Array.isArray(fallback) && typeof v === typeof fallback;

/** The fourth value re-reads after a failed first read (undefined once a read worked).
 *  Ticket 993: the value is the one last set while the core has not answered it yet, so a caller that builds its next
 *  value from this one (an object or a list: `{ ...stored, [k]: v }`) keeps an edit made a moment before; the stored
 *  value arrived only with the reply, and of two quick edits the second wrote the whole value without the first. A
 *  refused write goes back to the stored value, with its error. */
export function useCoreFeature<T>(key: string, fallback: T): [T, (v: T | null, extra?: Record<string, unknown>) => Promise<boolean>, string, (() => void) | undefined, boolean] {
  const core = useContext(CoreFeatureClient);
  if (!core) throw new Error('useCoreFeature runs inside a Settings page or section');
  const [value, setValue] = useState<T>(fallback);
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const [error, setError] = useState('');
  // Read through a ref: a fallback written inline (a new array each render) must not re-read the core each render.
  const fb = useRef(fallback);
  fb.current = fallback;
  // shortcut: the type check is shallow (a JSON type, not its shape); a feature with an object value cleans it itself.
  const take = useCallback(
    (r: unknown) => {
      const v = (r as Reply).settings.features?.[key];
      setValue(sameType(v, fb.current) ? (v as T) : fb.current);
    },
    [key],
  );
  const fail = (e: unknown) => setError(rawError(e));
  const [read, setRead] = useState(false);
  const load = useCallback(
    () => void core.request({ op: 'quit_settings' }).then((r) => (take(r), setRead(true), setError('')), fail),
    [core, take],
  );
  useEffect(load, [load]);
  const set = useCallback(
    // `extra`: other patch fields sent with it (ticket 456: `extensions_confirmed`).
    (v: T | null, extra?: Record<string, unknown>) => {
      const mine = { value: v === null ? fb.current : v };
      setPending(mine);
      return core
        .request({ op: 'quit_settings', patch: { ...extra, features: { [key]: v } } })
        .then(
          (r) => (take(r), setError(''), true),
          // A refused write re-reads the core's value, so the next change starts from what is stored, not a stale copy.
          (e) => (fail(e), void core.request({ op: 'quit_settings' }).then(take, () => {}), false),
        )
        .finally(() => setPending((p) => (p === mine ? null : p))); // a later set is still waiting: it stays
    },
    [core, key, take],
  );
  // The fifth: the core's value is in (until then the first is the fallback; a summary line leaves it out).
  return [pending ? pending.value : value, set, error, read || !error ? undefined : load, read];
}
