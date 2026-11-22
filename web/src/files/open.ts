// File tabs and the calls a file tab makes outside the core: open-at-line (Search, ticket 10), Reveal in Finder
// and the HTML sandbox source (the app's `artifact_open`). Outside the Tauri shell the last two use test hooks.
import { inApp } from '../settings/lifetime/tauri';
import { artifactUrl } from '../sandbox/url';
import type { ArtifactSource } from '../sandbox/ArtifactFrame';
import type { CoreClient } from '../api';

export interface FileRef {
  /** A session id (that session's folder or worktree); the core's `root`. */
  root: string;
  /** Relative to the root, `/`-separated. */
  path: string;
}

const PREFIX = 'file:';
export const fileTabId = (f: FileRef) => `${PREFIX}${f.root}:${f.path}`;
export const isFileTab = (id: string | null) => !!id?.startsWith(PREFIX);
export function fileOfTab(id: string | null): FileRef | null {
  if (!id || !isFileTab(id)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(':');
  return { root: rest.slice(0, at), path: rest.slice(at + 1) };
}
/** File tabs with unsaved edits (ticket 820): FileView keeps it, the one close path refuses these so no edit is lost. */
export const unsavedTabs = new Set<string>();
export const baseName = (p: string) => p.split('/').pop() || p;

export const OPEN_EVENT = 'nunchiro:files.open';
export type OpenDetail = FileRef & { line?: number };

/**
 * Opens `path` of session `root` in a read-only centre tab (focusing it if already open) and, for text, scrolls
 * to `line` (1-based) and marks it. Search (ticket 10) calls this for a match.
 */
export function openFileAt(root: string, path: string, line?: number) {
  window.dispatchEvent(new CustomEvent<OpenDetail>(OPEN_EVENT, { detail: { root, path, line } }));
}

interface TestHooks {
  reveal?: (path: string) => void;
  artifact?: (root: string, path: string, text: string) => Promise<ArtifactSource>;
  src?: (id: string) => string;
}
const hooks = () => (window as { __NUNCHIRO_FILES__?: TestHooks }).__NUNCHIRO_FILES__;

/** Shows the file in Finder; `cwd` is the session's folder. In a plain browser (tests) it only reports the path. */
export async function reveal(cwd: string, path: string) {
  const full = `${cwd.replace(/\/+$/, '')}/${path}`;
  if (!inApp()) return hooks()?.reveal?.(full);
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
  await revealItemInDir(full);
}

/** Ticket 375: the core opens the absolute `path` in the editor chosen in Settings, at `line` when that editor can jump.
 *  The core confines the path to the projects, session folders and managed worktrees; it opens on this Mac only. */
export const openInEditor = (core: CoreClient, path: string, line?: number) => core.request({ op: 'open_in_editor', path, ...(line ? { line } : {}) });

/** Registers the file with the app's artifact scheme, which reads it again through the core when the frame loads. */
export async function artifactFor(root: string, path: string, text: string): Promise<ArtifactSource> {
  const h = hooks();
  if (!inApp()) {
    if (!h?.artifact) throw new Error('HTML preview needs the Nunchiro app');
    return h.artifact(root, path, text);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ArtifactSource>('artifact_open', { root, path });
}
export const artifactSrc = (id: string) => (!inApp() && hooks()?.src?.(id)) || artifactUrl(id);
