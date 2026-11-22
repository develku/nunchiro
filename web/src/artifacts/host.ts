// Where artifact bytes come from (ticket v1b-06). HTML and SVG go to 04's sandbox frame through the app's
// `artifact_open` (v1b-09's CoreContent: an opaque id for `(root, path)`, bytes only from the core's `file_read`);
// Markdown and images are read with `file_read` over this window's core socket. No filesystem path reaches the frame.
import type { CoreClient } from '../api';
import { appGrant } from '../sandbox/grant';
import type { ArtifactSource } from '../sandbox/ArtifactFrame';
import { artifactUrl } from '../sandbox/url';
import { rawError } from '../errors';

export type Type = 'html' | 'svg' | 'markdown' | 'image';
/** The chat `artifact` event (crates/nunchiro-core/README.md, "Chat events"). */
export interface ArtifactData {
  kind: 'artifact';
  tool_id: string | null;
  source: 'written' | 'edited' | 'block';
  type: Type;
  root: string;
  path: string;
  title: string;
}
/** What a card or Preview shows: the file as a root and a path relative to it. */
export interface Target {
  root: string;
  path: string;
  type: Type;
  title: string;
}
/** Why a file shows no content: each has its own message (Card.tsx PROBLEM). */
export type Problem = 'missing' | 'too_large' | 'outside' | 'unsupported' | 'unavailable';

export interface Host {
  open(root: string, path: string): Promise<ArtifactSource>;
  src(id: string): string;
  grant(id: string, hash: string): Promise<void>;
}

declare global {
  interface Window {
    /** Browser tests stand in for the app's scheme (Playwright cannot load it); see web/tests/fixtures/artifacts/cards. */
    __NUNCHIRO_ARTIFACT_HOST__?: Host;
  }
}

const app: Host = {
  async open(root, path) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<ArtifactSource>('artifact_open', { root, path });
  },
  src: artifactUrl,
  grant: appGrant,
};

export const host = (): Host => window.__NUNCHIRO_ARTIFACT_HOST__ ?? app;

let core: CoreClient | null = null;
/** The window's core client (App binds it once). */
export function bindCore(c: CoreClient) {
  core = c;
}

export interface FileReply {
  kind: 'text' | 'markdown' | 'image' | 'svg' | 'html' | 'binary';
  size: number;
  too_large: boolean;
  text: string | null;
  data: number[] | null;
}

export async function readFile(root: string, path: string): Promise<FileReply> {
  if (!core) throw new Error('core disconnected');
  const r = (await core.request({ op: 'file_read', root, path })) as { type: string } & FileReply;
  if (r?.type !== 'file') throw new Error('unexpected reply');
  return r;
}

/** A path the file API refuses before reading: absolute, `..` or NUL. */
export const outsideRoot = (path: string) => path.startsWith('/') || path.includes('\0') || path.split('/').includes('..');

/**
 * Why a load gave nothing, asked of the file API itself: "not found", its root refusals, no text over 2 MB, or a
 * kind this view cannot show. A file the API reads fine was refused by the app (`artifact_open` missing or failing).
 */
export async function problemOf(t: Target): Promise<Problem> {
  if (outsideRoot(t.path)) return 'outside';
  try {
    const r = await readFile(t.root, t.path);
    if (r.too_large) return 'too_large';
    const shows = t.type === 'image' ? r.kind === 'image' : t.type === 'markdown' ? r.text !== null : r.kind === 'html' || r.kind === 'svg';
    return shows ? 'unavailable' : 'unsupported';
  } catch (e) {
    const m = rawError(e);
    return m === 'not found' ? 'missing' : /outside root|path not allowed/.test(m) ? 'outside' : 'unavailable';
  }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** An image reply as a `data:` URL (the window's CSP allows `img-src data:`); scripts never run in an `<img>`. */
export function imageUrl(path: string, data: number[]): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.slice(i, i + 0x8000));
  return `data:${MIME[ext] ?? 'image/png'};base64,${btoa(s)}`;
}
