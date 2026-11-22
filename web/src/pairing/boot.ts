// V2.5-15: the browser role (docs/design/v25-web-access.md). The core's browser listener marks the page it serves with
// a meta tag; the Mac window's copy never has it. The device token lives in this origin's localStorage only and is
// sent only in the WebSocket subprotocol header (api.ts), never in a URL, cookie or log.
import { htmlLang } from '../i18n';

export const TOKEN_KEY = 'nunchiro.device-token';

export const isBrowserRole = () => !!document.querySelector('meta[name="nunchiro-browser"]');

/** Ticket 528: a paired browser is another device, so its own language picks the catalogue (matched to our 8, else
 * English). The window's choice lives in the window's storage; the core never carries it to paired clients. Sets the
 * `<html lang>` every `useHtmlLangT` on these pages reads; call it before the first of them renders. */
export function applyBrowserLanguage(tag = navigator.language) {
  document.documentElement.lang = htmlLang('system', tag);
}

/** Storage can be blocked (private windows); the page then pairs but cannot keep the pairing. */
export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): boolean {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    return localStorage.getItem(TOKEN_KEY) === token;
  } catch {
    return false;
  }
}

export function forgetToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored.
  }
}

/** A suggested device name from the user agent ("iPhone · Safari"); the owner can edit it. */
export function deviceName(ua = navigator.userAgent): string {
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const app = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return app ? `${device} · ${app}` : device;
}
