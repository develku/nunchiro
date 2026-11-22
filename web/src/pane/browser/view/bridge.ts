// V2.5-19: the app's native browser view (app/src-tauri/src/browser). In a plain browser there is no view.
import type { Failure } from './failure';

export const inApp = () => '__TAURI_INTERNALS__' in window;
export type Rect = { x: number; y: number; w: number; h: number };

export async function call(cmd: string, args: Record<string, unknown>): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke(cmd, args);
}
/** Ticket 535: after a key forwarded from a page, `back` gives that page the key focus again (what the key opened closed
 *  without acting); otherwise the app forgets the page. A no-op when no key was forwarded, and outside the app. */
export function pageFocus(back: boolean): void {
  if (inApp()) void call('browser_refocus', { back }).catch(() => {});
}
/** The page the native view reached (every page load); returns the unsubscribe. `tab`: ticket 328 part 2, the agent's tab
 *  number (absent: tab 1, the pane's own view). */
export async function onMoved(f: (space: string, url: string, tab: number) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ space: string; url: string; tab?: number }>('browser-moved', (e) => f(e.payload.space, e.payload.url, e.payload.tab ?? 1));
}
/** A page that could not load (the native view stays blank), with WebKit's reason; returns the unsubscribe. */
export async function onFailed(f: (space: string, failure: Failure, tab: number) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<Failure & { space: string; tab?: number }>('browser-failed', (e) => f(e.payload.space, e.payload, e.payload.tab ?? 1));
}
