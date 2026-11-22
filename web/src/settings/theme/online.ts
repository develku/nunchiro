// Theme gallery, online part (V1A-47 fetcher, V1A-62 budget): iTerm2-Color-Schemes themes at the catalog's pinned
// commit. The core fetches, validates and caches; the window asks for the index when the Theme page opens and for a
// theme file only for cards on screen, at most MAX_IN_FLIGHT at once, each name once per window session. Names,
// licences and sources render as text only, and a theme arrives as validated #rrggbb colours (rechecked here).
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { CoreClient } from '../../api';
import { validColors } from '../../themes/ghostty';
import { isSource } from '../../themes/import';
import type { ThemePick } from '../../themes/nunchiro';
import { docT, lineError, rawError } from '../../errors';

export type Entry = { name: string; license: string; source: string };
export type Index = { state: 'idle' | 'loading' | 'error' } | { state: 'ok'; themes: Entry[] };
export type File = { state: 'ok'; pick: ThemePick } | { state: 'error'; error: string };

/** The core's own cap is also 4 (themes_online.rs MAX_IN_FLIGHT), across windows. */
export const MAX_IN_FLIGHT = 4;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

const entries = (r: unknown): Entry[] => {
  const list = (r as { themes?: unknown })?.themes;
  return Array.isArray(list) ? list.filter((e): e is Entry => text(e?.name, 200) && text(e?.license, 500) && text(e?.source, 500)) : [];
};
const toPick = (r: unknown, name: string): ThemePick | null => {
  const t = (r as { theme?: Record<string, unknown> })?.theme;
  const colors = validColors(t?.colors);
  if (!t || !colors || t.name !== name || !text(t.license, 100) || !isSource(t.source)) return null;
  return { id: `imported:${name}`, name, colors, source: t.source as string, licence: t.license as string };
};
// The card's tooltip (its visible words are the catalogue's "Did not load"): offline in plain words, else the raw reason.
const reason = (e: Error) => (/^core disconnected$|HTTP|timed out|request|curl/.test(rawError(e)) ? docT()('err.themeOffline') : lineError(docT(), e));

/** The index, asked once each time the page opens with the setting on (the core caches it); off sends nothing. */
export function useIndex(core: CoreClient, on: boolean): [Index, () => void] {
  const [index, setIndex] = useState<Index>({ state: 'idle' });
  const load = useCallback(() => {
    setIndex({ state: 'loading' });
    core.themes({ op: 'theme_index' }).then(
      (r) => setIndex({ state: 'ok', themes: entries(r) }),
      () => setIndex({ state: 'error' }),
    );
  }, [core]);
  useEffect(() => {
    if (on) load();
  }, [on, load]);
  return [on ? index : { state: 'idle' }, load];
}

// Window session memo: answers and failures by name; Retry clears one failure.
const memo = new Map<string, File>();
const flying = new Set<string>();
let version = 0;
const subs = new Set<() => void>();
const changed = () => {
  version++;
  for (const fn of subs) fn();
};
const subscribe = (fn: () => void) => (subs.add(fn), () => void subs.delete(fn));

export function retryFile(name: string) {
  if (memo.get(name)?.state === 'error') memo.delete(name);
  changed();
}

/**
 * Theme files for `wanted` (the cards on screen, in order). Only names still wanted are sent, so a changed search or
 * filter drops what was queued; replies to calls already sent are kept in the memo.
 */
export function useThemeFiles(core: CoreClient, wanted: string[]): ReadonlyMap<string, File> {
  const v = useSyncExternalStore(subscribe, () => version);
  const key = JSON.stringify(wanted);
  useEffect(() => {
    for (const name of JSON.parse(key) as string[]) {
      if (flying.size >= MAX_IN_FLIGHT) break;
      if (memo.has(name) || flying.has(name)) continue;
      flying.add(name);
      core
        .themes({ op: 'theme_file', name })
        .then(
          (r) => {
            const pick = toPick(r, name);
            memo.set(name, pick ? { state: 'ok', pick } : { state: 'error', error: 'That theme file is not valid.' });
          },
          (e: Error) => memo.set(name, { state: 'error', error: reason(e) }),
        )
        .finally(() => {
          flying.delete(name);
          changed();
        });
    }
  }, [core, key, v]);
  return memo;
}
