// V2-10c (needs 91): the artifact library card's seams. The card list comes only from the app's parse of the served
// page bytes (`artifact_lib_cards`), never from a frame message; Allow, auto-allow and Remove are window-only core ops
// sent from the owner's clicks. Library, file and requester come from page bytes: they render as text, never HTML.
import { CoreClient, type LibEntry, type LibsList } from '../api';

/** One unpinned `<script src>`: the core's `needs_card` fields plus the tag's own `integrity` attribute. */
export interface LibCard {
  url: string;
  host: string;
  library: string;
  version: string;
  file: string;
  /** cdnjs lists this library, version and file in the shipped manifest. */
  listed: boolean;
  /** An auto-allowed fetch is running: the card shows until the pin exists. */
  auto: boolean;
  /** Pinned versions of the same host, library and file ("Open with"). */
  other_versions: string[];
  /** Text 7: not on this Mac yet. */
  message: string;
  integrity: string | null;
}
export interface LibRefused {
  url: string;
  text: number;
  message: string;
}
export interface LibCards {
  cards: LibCard[];
  refused: LibRefused[];
  pinned: number;
}

declare global {
  interface Window {
    /** Browser tests stand in for the app's commands and the core's Allow (like `__NUNCHIRO_ARTIFACT_HOST__`). */
    __NUNCHIRO_LIBS__?: LibsBridge;
  }
}

/** What the frame needs; injectable for tests like `grant`. */
export interface LibsBridge {
  cards(id: string, hash: string): Promise<LibCards>;
  /** Resolves to the one-view token the next frame load carries as `?view=` (V2-38). */
  openWith(id: string, hash: string, url: string, sha384: string): Promise<string>;
  allow(url: string, integrity: string | null, requester: string): Promise<void>;
  list(): Promise<LibsList>;
}

export const HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdn.tailwindcss.com', 'code.jquery.com'];
export const CDNJS = HOSTS[0];
export const MAX_CARDS = 8;
/** The core's per-file cap (`libs::FILE_CAP`). */
export const FILE_CAP = 8 * 1024 * 1024;
/** The requester Allow sends when the frame names none (V2-37), worded like the card's "Asked by" line for it. */
export const NO_REQUESTER = 'a page not opened from a session';
/** A card's buttons arm this long after it appears or moves (misclick and clickjack guard). */
export const ARM_MS = 500;
export const POLL_MS = 1000;
export const POLL_MAX = 40;
export const REASON = 'Same CDN and exact-version rule as Claude.ai artifacts';
export const UNVERIFIED_HOVER = "Not checked against cdnjs's published hashes: the file came from the host as is.";
// The spec's texts, worded like the core's (libs/grammar.rs `text`).
export const leaves = (host: string) => `Only this library request goes to ${host}: your IP and the URL. Nothing from the page is sent.`;
export const denied = (c: LibCard) => `You did not allow \`${c.library}\` \`${c.version}\`. The page runs without it.`;
/** The card list could not be read (the app refused it): its CDN scripts stay blocked, and the page says so. */
export const UNREAD = "Nunchiro could not read this page's libraries, so its CDN scripts stay blocked. Open it again to retry.";
/** `cards` outside the app (a browser page, a test harness): no card and no note. */
export const NOT_APP = 'not the app';
export const runtimeLoad = (host: string) => `This page loads code from \`${host}\` while it runs. Only \`<script>\` tags with exact versions are supported.`;

/** Text 10's URL: a CSP report's blocked URL on one of the five hosts, else null (display only, never a card). */
export function runtimeLoadUrl(report: unknown): URL | null {
  const blocked = (report as { blocked?: unknown } | null)?.blocked;
  if (typeof blocked !== 'string' || blocked.length > 2048) return null;
  try {
    const u = new URL(blocked);
    return u.protocol === 'https:' && HOSTS.includes(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** Newest first: 4.10.0 before 4.9.1, and a release before its prerelease (4.4.0 before 4.4.0-beta). */
export const newestFirst = (versions: string[]) =>
  [...versions].sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split('-')[0]);
    return x === y ? Number(b === y) - Number(a === x) || b.localeCompare(a, 'en', { numeric: true }) : y.localeCompare(x, 'en', { numeric: true });
  });

/** The pinned entry "Open with <version>" serves in place of the card's version. */
export const entryFor = (c: LibCard, version: string, entries: LibEntry[]) =>
  entries.find((e) => e.host === c.host && e.library === c.library && e.file === c.file && e.version === version && /^[0-9a-f]{96}$/.test(e.sha384));

const str = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max;
const card = (v: unknown): v is LibCard => {
  const c = v as Record<string, unknown> | null;
  return (
    !!c &&
    [c.url, c.host, c.library, c.version, c.file, c.message].every((s) => str(s)) &&
    typeof c.listed === 'boolean' &&
    typeof c.auto === 'boolean' &&
    Array.isArray(c.other_versions) &&
    c.other_versions.every((s) => str(s, 64)) &&
    (c.integrity === null || str(c.integrity, 4096))
  );
};
const refused = (v: unknown): v is LibRefused => {
  const r = v as Record<string, unknown> | null;
  return !!r && str(r.url) && typeof r.text === 'number' && str(r.message);
};
/** Settings: a `libs_list` reply with only well-formed entries; anything but `saved: false` is not a set-aside file. */
export function cleanList(v: unknown): LibsList {
  const r = v as Record<string, unknown> | null;
  const entry = (e: unknown): e is LibEntry => {
    const x = e as Record<string, unknown> | null;
    return (
      !!x &&
      [x.host, x.path, x.library, x.version, x.file, x.sha384, x.first_requester].every((s) => str(s)) &&
      typeof x.sha512 === 'string' &&
      /^[0-9a-f]{128}$/.test(x.sha512) &&
      Number.isInteger(x.size) &&
      (x.size as number) > 0 &&
      (x.size as number) <= FILE_CAP &&
      Number.isFinite(x.fetched_at) &&
      (x.badge === 'verified' || x.badge === 'unverified')
    );
  };
  const auto = (a: unknown): a is LibsList['auto_allow'][number] => str((a as { host?: unknown } | null)?.host) && str((a as { library?: unknown }).library);
  const autos = (v: unknown) => (Array.isArray(v) ? v.filter(auto) : []);
  return { entries: Array.isArray(r?.entries) ? r.entries.filter(entry) : [], auto_allow: autos(r?.auto_allow), defaults: autos(r?.defaults), saved: r?.saved !== false };
}

/** Keeps only well-formed answers (the contract caps a page at 32 tags). */
export function cleanCards(v: unknown): LibCards {
  const r = v as Record<string, unknown> | null;
  const list = <T,>(x: unknown, ok: (y: unknown) => y is T) => (Array.isArray(x) ? x.filter(ok).slice(0, 32) : []);
  return { cards: list(r?.cards, card), refused: list(r?.refused, refused), pinned: typeof r?.pinned === 'number' ? r.pinned : 0 };
}

async function invoke<T>(name: string, args: Record<string, string>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(name, args);
}
const core = () => {
  if (!CoreClient.main) throw new Error('core disconnected');
  return CoreClient.main;
};

/** The frame's default: a browser test's stand-in, else the app. */
export const libsBridge = (): LibsBridge => window.__NUNCHIRO_LIBS__ ?? appLibs;

/** The app's two commands (ticket 27b) and the window's core ops (ticket 27a). */
export const appLibs: LibsBridge = {
  cards: async (id, hash) => {
    if (!('__TAURI_INTERNALS__' in window)) throw new Error(NOT_APP);
    return cleanCards(await invoke('artifact_lib_cards', { id, hash }));
  },
  openWith: (id, hash, url, sha384) => invoke<string>('artifact_open_with', { id, hash, url, sha384 }),
  // Owner-only: called from the card's Allow click alone (libs-card.spec.ts `no_agent_path_reaches_libs_ops`).
  allow: async (url, integrity, requester) =>
    void (await core().libs({ op: 'libs_allow', url, requester: requester || NO_REQUESTER, ...(integrity ? { integrity } : {}) })),
  list: () => core().libs({ op: 'libs_list' }) as Promise<LibsList>,
};
