// Ticket 454: the version beside a Claude model alias ("Opus 5.5"). Claude Code's aliases name the latest model of a family
// and move when Claude Code updates; it has no command that lists them. What the user's own sessions ran is on record,
// though: the core's usage read gives the model ids of the last 7 days (`usage_detail`, local records only). The highest
// version seen per family is shown beside the alias, kept across restarts, and read again as a model menu opens, so a
// moved alias is followed once a session has run on it. A family never seen keeps its plain name.
import type { CoreClient } from '../api';

const KEY = 'nunchiro.models.seen.v1';
const FRESH_MS = 10 * 60_000;
/** `claude-<family>-<major>[-<minor>][-<yyyymmdd>]`; older ids (`claude-3-5-sonnet-…`) name no family here. */
const ID = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;

export type Seen = Record<string, string>;

/** Family to its highest version among `ids` ("5.5", or "5" with no minor). */
export function versionsFrom(ids: string[]): Seen {
  const best: Record<string, [number, number]> = {};
  for (const id of ids) {
    const m = ID.exec(id);
    if (!m) continue;
    const v: [number, number] = [Number(m[2]), m[3] === undefined ? -1 : Number(m[3])];
    const b = best[m[1]];
    if (!b || v[0] > b[0] || (v[0] === b[0] && v[1] > b[1])) best[m[1]] = v;
  }
  return Object.fromEntries(Object.entries(best).map(([family, [major, minor]]) => [family, minor < 0 ? `${major}` : `${major}.${minor}`]));
}

const stored = (): Seen => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => /^[a-z]+$/.test(e[0]) && typeof e[1] === 'string' && /^\d{1,2}(\.\d{1,2})?$/.test(e[1]))) : {};
  } catch {
    return {}; // no storage (node tests) or a broken value
  }
};
let seen: Seen = stored();
let readAt = 0;

/** The version last seen for a Claude family ("opus" → "5.5"), or ''. */
export const seenVersion = (family: string): string => seen[family] ?? '';

/** Reads the model ids of the last 7 days (at most every 10 minutes) and keeps the highest version per family. */
export async function refreshSeen(core: CoreClient, now = Date.now()): Promise<void> {
  if (now - readAt < FRESH_MS) return;
  readAt = now;
  try {
    const reply = (await core.request({ op: 'usage_detail', days: 7 })) as { detail?: { models?: { key: string }[] }; claude_default?: string };
    setDefault(reply.claude_default ?? ''); // W35-picker2 S3: the user's own default, read with the versions
    const next = versionsFrom((reply.detail?.models ?? []).map((m) => m.key));
    if (!Object.keys(next).length) return;
    seen = { ...seen, ...next };
    try {
      localStorage.setItem(KEY, JSON.stringify(seen));
    } catch {
      // kept for this run only
    }
  } catch {
    readAt = 0; // the next menu asks again
  }
}

/** Test seam: what is shown, set directly. */
export const setSeen = (next: Seen) => void (seen = next);

/** W35-picker2 S3: the Claude alias the user's own settings name as their default model (`claude_default` of
 *  usage_detail), its Default pill; '' while they name none (Claude then picks by plan). Kept across restarts. */
const DEFAULT_KEY = 'nunchiro.models.default.v2';
let defaultAlias = (() => {
  try {
    return /^[a-z]+$/.test(localStorage.getItem(DEFAULT_KEY) ?? '') ? localStorage.getItem(DEFAULT_KEY)! : '';
  } catch {
    return '';
  }
})();
export const claudeDefault = () => defaultAlias;
/** The family of a model alias or id (`sonnet`, `opus[1m]`, `claude-sonnet-5-5` → sonnet); '' for none. */
export const familyOf = (model: string) => {
  const plain = model.replace(/\[1m\]$/, '');
  return /^[a-z]+$/.test(plain) ? plain : (ID.exec(plain)?.[1] ?? '');
};
function setDefault(model: string) {
  defaultAlias = familyOf(model);
  try {
    if (defaultAlias) localStorage.setItem(DEFAULT_KEY, defaultAlias);
    else localStorage.removeItem(DEFAULT_KEY);
  } catch {
    // kept for this run only
  }
}
