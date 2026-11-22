// Window side of the core's file API (crates/nunchiro-core README, "File access"): these requests and Search's
// `files_search` (web/src/search) are its only file calls. `file_write` (ticket 820) is the one write: the file view's
// Save, of a text file it read, refused by the core if the file changed since. // v1b-10
import type { CoreClient } from '../api';
import { rawError } from '../errors';

export interface Entry {
  name: string;
  /** `dir`, `file` or `symlink`. */
  kind: string;
  size: number;
  ignored: boolean;
  git: string | null;
}

export interface FileContent {
  kind: string;
  size: number;
  too_large: boolean;
  text?: string | null;
  data?: number[] | null;
  /** Sent by the core since v1b-09 r3; optional so an older core still works. Compared only over 2 MB. */
  mtime_ms?: number | null;
  /** SHA-256 of the bytes read, sent with `text` since ticket 820; a save hands it back. */
  hash?: string | null;
}

export const listDir = (core: CoreClient, root: string, path: string) =>
  core.request({ op: 'files_list', root, path }).then((r) => (r as { entries: Entry[] }).entries);

export const readFile = (core: CoreClient, root: string, path: string) =>
  core.request({ op: 'file_read', root, path }) as Promise<FileContent>;

/** The core's own limit (files/mod.rs MAX_EDIT): a larger file is not offered for editing. */
export const MAX_EDIT = 512 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
/** Ticket 820: saves `text` over the file whose read returned `hash`; the reply is the file as read again. A text over the
 *  limit is refused here in the core's words, before it is sent: the window socket drops a message over 1 MiB (its JSON
 *  escaping included; http/mod.rs MAX_MESSAGE). */
export function writeFile(core: CoreClient, root: string, path: string, text: string, hash: string) {
  if (bytes(text) > MAX_EDIT || bytes(JSON.stringify(text)) > 1_000_000) return Promise.reject(new Error('the text is over 512 KiB; nothing was saved'));
  return core.request({ op: 'file_write', root, path, text, hash }) as Promise<FileContent>;
}

/** What the viewer renders. A `kind` this window does not know (a newer core) is shown as binary. */
export type View = 'text' | 'markdown' | 'image' | 'svg' | 'html' | 'binary' | 'large';
const KNOWN = ['text', 'markdown', 'image', 'svg', 'html', 'binary'];
export function viewOf(c: FileContent): View {
  if (c.too_large) return 'large';
  if (!KNOWN.includes(c.kind)) return 'binary';
  if (c.kind === 'image' ? !c.data : c.kind !== 'binary' && typeof c.text !== 'string') return 'binary';
  return c.kind as View;
}

/**
 * Same file as last time: size, kind, a hash when the core sends one, and the full text or bytes. Over 2 MB the core
 * sends no bytes, so mtime stands in for them there; below, a touch with the same bytes is not a change.
 */
export function sameContent(a: FileContent, b: FileContent) {
  if (a.size !== b.size || a.kind !== b.kind || a.too_large !== b.too_large || (a.text ?? null) !== (b.text ?? null)) return false;
  for (const k of a.too_large ? (['mtime_ms', 'hash'] as const) : (['hash'] as const))
    if (a[k] != null && b[k] != null && a[k] !== b[k]) return false;
  const x = a.data ?? [];
  const y = b.data ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The core's error for a path that no longer exists (ENOENT from the open). */
export const isGone = (e: unknown) => /^(not found|root unavailable)$|os error 2\b/.test(rawError(e));

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
