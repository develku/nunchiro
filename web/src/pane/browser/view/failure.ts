// Ticket 329: the pure rules behind the Browser's failed-load surface. This file imports nothing, so the spec can load it in node.
// Cause list and copy adapted from Orca src/shared/browser-load-failure.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
export type Failure = { error: string; code: number; url: string };
export type Cause = 'refused' | 'dns' | 'timeout' | 'offline' | 'other';

// NSURLError codes: WebKit's message follows the system language, so only the code can name the cause.
const CAUSES = new Map<number, Cause>([
  [-1004, 'refused'],
  [-1003, 'dns'],
  [-1006, 'dns'],
  [-1001, 'timeout'],
  [-1009, 'offline'],
]);
export const causeOf = (code: number): Cause => CAUSES.get(code) ?? 'other';

const parse = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};
export const hostOf = (url: string) => parse(url)?.host || url;
export const isWeb = (url: string) => ['http:', 'https:'].includes(parse(url)?.protocol ?? '');

/** The origin the app opens for this address bar text (view.rs `normalize`): a bare address is https unless it is loopback. */
const originOf = (text: string) => {
  const t = text.trim();
  return parse(t.includes('://') ? t : `${/^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/.test(t) ? 'http' : 'https'}://${t}`)?.origin;
};

/** A local dev server that is not up yet. `typed`: what this pane was asked to open ('' for none), since a retry goes through
 *  `browser_go`, which pauses the agent, and must not drag an agent's view back. Same origin, so a typed site that redirects to a
 *  loopback address cannot make the pane keep calling it. `.localhost` is what the app shows a worktree's server under (route.ts). */
export const retriesItself = (cause: Cause, url: string, typed: string) =>
  cause === 'refused' && isWeb(url) && /^(localhost|127\.0\.0\.1)$|\.localhost$/.test(parse(url)!.hostname) && originOf(typed) === parse(url)!.origin;
