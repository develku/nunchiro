const v4Private = ([a, b]: number[]) =>
  a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));

// `URL` has already normalised numeric hosts (`2130706433`, `0x7f.1`) to dotted form and IPv6 to compressed hex.
function publicHost(host: string): boolean {
  if (host.startsWith('[')) {
    const h = host.slice(1, -1);
    // `::` prefixes (loopback, mapped, compatible), ULA fc00::/7, link-local and site-local fe80::/9, multicast,
    // and the ranges that embed an IPv4 address (6to4, NAT64, Teredo) or are documentation.
    return !/^(:|f[c-f][0-9a-f]{0,2}:|fe[89a-f]|ff|2002:|64:ff9b:|2001:0?:|2001:db8:)/.test(h);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !v4Private(host.split('.').map(Number));
  // Single-label names and local-only suffixes resolve inside the user's network; a trailing dot is a bypass.
  return host.includes('.') && !host.endsWith('.') && !/\.(localhost|local|lan|internal|localdomain|home\.arpa)$/.test(host);
}

/**
 * Links leave through the user's browser, never inside the window (ADR: links). Only public http(s) hosts pass:
 * an artifact must not be able to point the browser at the core, the user's router or a cloud metadata address.
 */
export function webUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || !publicHost(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export async function openExternal(url: string) {
  if ('__TAURI_INTERNALS__' in window) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else window.open(url, '_blank', 'noopener');
}
