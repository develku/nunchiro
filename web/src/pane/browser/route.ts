// Ticket 256 (needs 197, G06): the pure rule for where a clicked http(s) link opens, and the worktree label check.
// The settings, the opener and the Settings section are features/link-routing.tsx; this file imports nothing, so the
// spec can load it in node.
export type Prefs = { inApp: boolean; shiftFlips: boolean; background: boolean; labels: boolean };
export type Origin = 'terminal' | 'chat' | 'files';

/** Shift+click does the opposite (when on); the background only for a link clicked in a terminal or the chat. */
export function route(p: Prefs, shift: boolean, origin: Origin): 'external' | 'pane' | 'background' {
  if (p.inApp === (shift && p.shiftFlips)) return 'external';
  return p.background && origin !== 'files' ? 'background' : 'pane';
}

// The app's own origins (the Tauri page, the artifact sandbox): a dev server must never be shown under them (threat A18).
const RESERVED = new Set(['tauri', 'nunchiro-artifact']);
/** `<label>.localhost` for a worktree label, or null when the label would make a reserved host (any case, trailing dot). */
export function labelHost(label: string): string | null {
  const l = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return l && !RESERVED.has(l) ? `${l}.localhost` : null;
}
/** A localhost URL shown under the worktree label (O-178); anything else, or a refused label, unchanged. */
export function labelled(url: string, label: string | null | undefined): string {
  const host = label ? labelHost(label) : null;
  try {
    const u = new URL(url);
    if (!host || !['localhost', '127.0.0.1'].includes(u.hostname)) return url;
    u.hostname = host;
    return u.href;
  } catch {
    return url;
  }
}
