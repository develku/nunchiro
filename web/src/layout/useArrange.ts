// The arrangement's history (LAYOUT D5b A23-A28): zones (layout.toml, through the LayoutStore) and bars (window
// settings) change in steps; one trail orders them, so Undo and ⌘Z step back one change whichever kind it was.
// A step remembers what it changed: the zones are the store's own undo, the bars and preset name a snapshot.
import { docT, tipError } from '../errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../settings';
import { defaultBars, members, same, type Bars } from './bars';
import { find, names, dirty as presetDirty, type Preset } from './presets';
import type { Layout } from './model';
import { HISTORY, type LayoutStore } from './store';

interface Step {
  zones: boolean;
  bars?: Bars;
  preset?: string;
}
export interface Toast {
  text: string;
  /** Offers Undo; a plain notice (a refusal, a hint) does not. */
  undo: boolean;
  n: number;
  /** A notice about one session (ticket 399): it closes when another session is selected. */
  session?: string;
}
/** A plain notice leaves after this long, like the worktree and migration toasts (ticket 399). An Undo toast stays: the
 *  status line offers the same Undo, but the toast is where the user just looked. */
const TOAST_MS = 10_000;
type Say = (m: { text: string; error: boolean } | null) => void;

export function useArrange(store: LayoutStore, settings: Settings, update: (p: Partial<Settings>) => void, say: Say) {
  const [trail, setTrail] = useState<Step[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const live = useRef({ settings, trail });
  live.current = { settings, trail };
  const edit = useRef<{ bars: Bars; preset: string } | null>(null);
  const notify = useCallback((text: string, undo = false, session?: string) => setToast({ text, undo, n: Date.now(), session }), []);
  useEffect(() => {
    if (!toast || toast.undo) return;
    const id = window.setTimeout(() => setToast((x) => (x === toast ? null : x)), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);
  const steps = (t: Step[]) => (setTrail(t), (live.current.trail = t));

  /** One change. `zone` runs first (it may refuse); a change that moves nothing is not a step (A28). */
  const commit = useCallback(
    async (text: string, c: { zone?: () => Promise<unknown>; bars?: Bars; preset?: string }) => {
      const cur = live.current.settings;
      const barsChanged = !!c.bars && !same(c.bars, cur.bars);
      if (!c.zone && !barsChanged && (c.preset === undefined || c.preset === cur.preset)) return false;
      // Only the open widget differs (a drop on its own place): the sidebar opens, but it is not a step (A28).
      if (!c.zone && c.bars && members(c.bars) === members(cur.bars) && (c.preset === undefined || c.preset === cur.preset)) return void update({ bars: c.bars }), false;
      try {
        await c.zone?.();
      } catch (e) {
        say({ text: tipError(docT(), e), error: true });
        return false;
      }
      update({ ...(barsChanged ? { bars: c.bars } : {}), ...(c.preset !== undefined ? { preset: c.preset } : {}) });
      steps([...live.current.trail, { zones: !!c.zone, bars: barsChanged ? cur.bars : undefined, preset: c.preset !== undefined ? cur.preset : undefined }].slice(-HISTORY));
      notify(text, true);
      return true;
    },
    [notify, say, update],
  );
  /** A zone step the store already ran (a drag, a typed command). */
  const zoneStep = useCallback(
    (text: string) => {
      steps([...live.current.trail, { zones: true }].slice(-HISTORY));
      if (store.editing) notify(text, true);
    },
    [notify, store],
  );
  const undo = useCallback(async () => {
    const t = live.current.trail.at(-1);
    if (!t) return store.run({ op: 'undo' }); // nothing of ours: the store's own history (a CLI change, an earlier edit)
    steps(live.current.trail.slice(0, -1));
    if (t.zones) await store.run({ op: 'undo' });
    update({ ...(t.bars ? { bars: t.bars } : {}), ...(t.preset !== undefined ? { preset: t.preset } : {}) });
    notify('Undone');
  }, [notify, store, update]);

  const begin = useCallback(() => {
    if (store.editing) return;
    store.edit();
    edit.current = { bars: live.current.settings.bars, preset: live.current.settings.preset };
    steps([]);
    setToast(null);
  }, [store]);
  const cancel = useCallback(() => {
    const was = edit.current;
    store.cancel();
    if (was) update({ bars: was.bars, preset: was.preset });
    edit.current = null;
    steps([]);
    setToast(null);
  }, [store, update]);
  const ended = useCallback(() => {
    edit.current = null;
    steps([]);
    setToast(null);
  }, []);

  const loadPreset = (name: string) => {
    const p = find(live.current.settings.presets, name);
    if (p) void commit(`Loaded preset ${name}`, { zone: () => store.set({ version: 1, root: p.root }, `preset ${name}`), bars: p.bars, preset: name });
  };
  const resetAll = () => commit('Restored the default arrangement', { zone: () => store.run({ op: 'reset' }), bars: defaultBars(), preset: 'Default' });
  const upsert = (name: string, layout: Layout) => {
    const p: Preset = { name, root: structuredClone(layout.root), bars: structuredClone(live.current.settings.bars) };
    return [...live.current.settings.presets.filter((x) => x.name !== name), p];
  };
  const savePreset = (layout: Layout) => {
    const name = live.current.settings.preset;
    update({ presets: upsert(name, layout) });
    say({ text: `Saved preset ${name}`, error: false });
  };
  const saveAs = (layout: Layout, raw: string) => {
    const name = raw.trim();
    if (!name) return false;
    update({ presets: upsert(name, layout), preset: name });
    say({ text: `Saved preset ${name}`, error: false });
    return true;
  };

  const menu = (layout: Layout) => {
    const s = settings;
    return { names: names(s.presets), current: s.preset, dirty: presetDirty(find(s.presets, s.preset), layout, s.bars), onLoad: loadPreset, onSave: () => savePreset(layout), onSaveAs: (n: string) => saveAs(layout, n) };
  };

  return { steps: trail.length, toast, dismiss: () => setToast(null), notify, commit, zoneStep, undo, begin, cancel, ended, resetAll, menu };
}
