// v25-new-tab (ticket 290): the New tab popover's URL row asks the session's Browser tab to open an address. The tab may not
// be mounted yet (the side pane opens in the same breath), so the address waits here until its view takes it, and a mounted
// view hears the event. Only http(s) addresses travel: the event is on `window`, which any script can reach.
export const BROWSER_GO_EVENT = 'nunchiro:browser.go';
const pending = new Map<string, string>();

/** The address as an http(s) URL, or null for anything else (`javascript:`, `file:`, text). */
export function webUrl(text: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `http://${text}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function queueBrowserGo(space: string, url: string) {
  const ok = webUrl(url);
  if (!ok) return;
  pending.set(space, ok);
  window.dispatchEvent(new CustomEvent(BROWSER_GO_EVENT, { detail: { space } }));
}

/** The address waiting for this space's Browser tab, once. */
export function takeBrowserGo(space: string): string | null {
  const url = pending.get(space) ?? null;
  pending.delete(space);
  return url;
}
