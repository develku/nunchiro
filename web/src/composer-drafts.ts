// Copyright (c) 2026 T3 Tools Inc. (MIT), for the parts ported from T3 Code named below.
// V2.5-54 A8 (needs 139): unsent composer text, one draft per session, in memory and in localStorage, so it comes back
// after a tab switch and after a reload. Stash (chat/stash.ts) is a separate store and does not touch this one.
//
// Ported from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.; THIRD_PARTY_NOTICES.md): the shape of
// `apps/web/src/composerDraftStore.ts` (a per-thread draft map persisted under one versioned key) and of
// `apps/web/src/lib/storage.ts` `createDeferredStorage` (a debounced write that is flushed when the page goes away, a memory
// fallback when storage is missing). Its zustand store, Effect schemas and image/terminal-context fields are not used here:
// images have their own store (images/attach.ts) and this one keeps plain text.

// Bounded (review MUST): a draft keeps its first 100 KB (never dropped whole), and at most 50 drafts stay, the least
// recently written going first, so closed sessions' drafts cannot pile up in storage.
import { withoutEnvValues } from './features/pasted-server';

const MAX_CHARS = 100_000;
const MAX_DRAFTS = 50;
const KEY = 'nunchiro.composer.drafts.v1';
const WAIT_MS = 300;

const mem = new Map<string, string>();
let loaded = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function keep(id: string, text: string) {
  mem.delete(id); // a map keeps insertion order: the last entry is the newest write
  let cut = text.slice(0, MAX_CHARS);
  if (cut.length < text.length && /[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never keep half an emoji
  mem.set(id, cut);
  while (mem.size > MAX_DRAFTS) mem.delete(mem.keys().next().value!);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    // A store of another shape (hand edit, older build) is ignored, not trusted.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [id, text] of Object.entries(raw)) if (typeof text === 'string' && text) keep(id, text);
  } catch {
    /* no storage, or not JSON: start empty */
  }
}

/** Writes now what the debounce was holding. */
export function flushDrafts() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  try {
    // Ticket 1130 round 2: env values of a pasted `claude mcp add -e KEY=…` line stay in memory only.
    if (mem.size) localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...mem].map(([id, text]) => [id, withoutEnvValues(text)]))));
    else localStorage.removeItem(KEY);
  } catch {
    /* quota or blocked storage: the draft lives in memory for this window */
  }
}

// A model spec may leave a bare `window` object in its worker: no listeners there.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', flushDrafts);
  window.addEventListener('beforeunload', flushDrafts);
}

export function getDraft(id: string): string {
  load();
  return mem.get(id) ?? '';
}

/** An empty text drops the draft. */
export function setDraft(id: string, text: string) {
  load();
  if (text) keep(id, text);
  else if (!mem.delete(id)) return;
  clearTimeout(timer);
  timer = setTimeout(flushDrafts, WAIT_MS);
}
