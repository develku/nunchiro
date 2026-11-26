// Type in terminal (mockup docs/design/draft-hold/index.html, panel 4): letters typed in a Claude or Codex terminal go to
// the window's composer, unless the owner turns this on for that session. While it is on, the core holds other senders'
// messages (`direct`); it goes off with Done, when the terminal loses focus, or when another session comes to the front.
import { useSyncExternalStore } from 'react';
import type { CoreClient } from '../api';

const on = new Set<string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let renew = 0;
let client: CoreClient | null = null;

/** The core ends it 60 s after the last key or renewal (a window that died); a live window renews it every 30 s. */
const tick = () => on.forEach((id) => void client?.request({ op: 'direct', id, on: true }).catch(() => {}));

export function setDirect(core: CoreClient, id: string, value: boolean) {
  if (on.has(id) === value) return;
  client = core;
  if (value) on.add(id);
  else on.delete(id);
  // A core that refuses it (an older one, a remote session) holds nothing: the switch goes off again.
  void core.request({ op: 'direct', id, on: value }).catch(() => value && on.delete(id) && (window.clearInterval(renew), emit()));
  window.clearInterval(renew);
  if (on.size) renew = window.setInterval(tick, 30_000);
  emit();
}
export const isDirect = (id: string) => on.has(id);
export const useDirect = (id: string) => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => on.has(id));

/** Every session's Type in terminal goes off but `keep` (another session came to the front). */
export function directOnly(core: CoreClient, keep: string | null) {
  for (const id of [...on]) if (id !== keep) setDirect(core, id, false);
}

/** What the composer takes from a terminal: printable text or one bracketed paste, its marks taken off. Anything else (an
 *  Esc, Ctrl+C, an arrow, Enter, Tab, Shift+Tab, a backspace) is a key for the agent: `null`. */
export function composerText(data: string): string | null {
  const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
  if (paste) return paste[1].includes('\x1b') ? null : paste[1];
  // eslint-disable-next-line no-control-regex
  return data && !/[\x00-\x1f\x7f]/.test(data) ? data : null;
}

/** The terminal hands its text to the session's composer (CentreView puts it at the caret). */
export const COMPOSE = 'nunchiro:compose';
export type Compose = { id: string; text: string; taken?: boolean };
/** One listener takes each piece (`taken`), however many views listen. */
export const toComposer = (id: string, text: string) => window.dispatchEvent(new CustomEvent<Compose>(COMPOSE, { detail: { id, text } }));
