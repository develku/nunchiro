// V2.5-15 (needs 139): a half-written prompt put aside from one composer, applied in any other. Text and the images' files.
// Ticket 371 item 24: it survives a reload in IndexedDB (blob-store.ts), bounded as T3 Code bounds its prompt stash: an entry
// cap, and what the budget took is named rather than lost quietly.
// ponytail: each window reads the store once at start, so a second window sees another's stash only after a reload.
// Listen on a BroadcastChannel if two windows at once ever matters.
import { useSyncExternalStore } from 'react';
import { accept } from '../images/attach';
import { blobStore } from './blob-store';

const MAX_ENTRIES = 20;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const KEY = 'stash:';

export interface Stashed {
  id: string;
  text: string;
  files: File[];
  /** The session it came from, as the user knew it. */
  from: string;
  /** When it was stashed: the order after a reload, newest first. */
  at: number;
  /** Images the byte budget took: only their names are left. */
  dropped: string[];
  /** Images that could not be read back from the store or failed the image check. */
  unreadable: string[];
}

let items: Stashed[] = [];
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const unsaved = (e: unknown) => console.warn('the stash change will not survive a reload', e); // the entry stays usable in memory

/** Newest first, at most the cap; over the byte budget, the oldest entry loses its images first and keeps their names. */
function fit(list: Stashed[]): Stashed[] {
  const out = list.slice(0, MAX_ENTRIES);
  let total = out.reduce((n, s) => n + s.files.reduce((m, f) => m + f.size, 0), 0);
  for (let i = out.length - 1; i >= 0 && total > MAX_TOTAL_BYTES; i--) {
    const files = [...out[i].files];
    const dropped = [...out[i].dropped];
    while (files.length && total > MAX_TOTAL_BYTES) {
      const f = files.shift()!;
      total -= f.size;
      dropped.push(f.name);
    }
    out[i] = { ...out[i], files, dropped };
  }
  return out;
}

function set(list: Stashed[]) {
  const next = fit(list);
  const gone = items.filter((x) => !next.some((y) => y.id === x.id)).map((x) => KEY + x.id);
  if (gone.length) blobStore.remove(gone).catch(unsaved);
  for (const s of next) if (!items.includes(s)) blobStore.write(KEY + s.id, s).catch(unsaved);
  items = next;
  notify();
}

const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** One stored record back, each image through accept() again so the magic-number check still applies. Null when its shape is wrong: the row would throw on render. */
async function revive(value: unknown): Promise<Stashed | null> {
  const r = value as Partial<Stashed> | null;
  if (typeof r?.id !== 'string' || typeof r.text !== 'string' || typeof r.from !== 'string' || typeof r.at !== 'number' || !Array.isArray(r.files) || !isNames(r.dropped) || !isNames(r.unreadable)) return null;
  const files: File[] = [];
  const unreadable = [...r.unreadable];
  for (const f of r.files) {
    try {
      files.push((await accept(f)).blob as File);
    } catch {
      unreadable.push(typeof f?.name === 'string' && f.name ? f.name : 'image');
    }
  }
  return { id: r.id, text: r.text, from: r.from, at: r.at, files, dropped: r.dropped, unreadable };
}

async function load() {
  const records = await blobStore.loadAll(KEY);
  const revived = await Promise.all(records.map(([, v]) => revive(v)));
  const malformed = records.filter((_, i) => !revived[i]).map(([key]) => key);
  if (malformed.length) blobStore.remove(malformed).catch(unsaved);
  const loaded = revived.filter((s) => s !== null);
  // Anything stashed while this ran is already in `items`.
  items = [...items, ...loaded.filter((s) => !items.some((x) => x.id === s.id))].sort((a, b) => b.at - a.at);
  notify();
}
load().catch((e) => console.warn('the stash could not be loaded', e));

export const stash = (s: Pick<Stashed, 'text' | 'files' | 'from'>): void => set([{ ...s, id: crypto.randomUUID(), at: Date.now(), dropped: [], unreadable: [] }, ...items]);
export const drop = (id: string): void => set(items.filter((x) => x.id !== id));
export const useStash = (): Stashed[] =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => items,
  );
