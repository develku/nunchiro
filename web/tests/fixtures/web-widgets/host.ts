// Browser stand-in for the app's web widget pages (app/src-tauri/src/artifacts/widget_page.rs). Playwright cannot load
// Tauri's custom scheme, so the frame loads a same-origin `/__widget/<id>` path that this route answers the way the
// scheme does: it asks the real core's `widget_page` over the owner socket on every request, serves the entry only
// while the approval hash has the id's prefix, inserts 04's bootstrap and sends the per-widget CSP built by the same
// rule as `widget_page::csp` (both pinned to one literal). Every core request it makes and every page it serves is
// recorded, so a test can assert what reached the core.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { CSP_DEFAULT } from '../../sandbox-server';

const ARTIFACTS = path.resolve(import.meta.dirname, '../../../../app/src-tauri/src/artifacts');
export const BOOTSTRAP = fs.readFileSync(path.join(ARTIFACTS, 'bootstrap.js'), 'utf8').trim();
// v1b-23: `first` in artifacts/mod.rs puts the bridge key before anything in a widget page, after a leading doctype.
export const BRIDGE_KEY = fs.readFileSync(path.join(ARTIFACTS, 'bridge-key.js'), 'utf8').trim();
function first(body: string) {
  const m = /^\s*<!doctype[^>]*>/i.exec(body);
  const at = m ? m[0].length : 0;
  return `${body.slice(0, at)}<script>${BRIDGE_KEY}</script>${body.slice(at)}`;
}

/** `widget_page::source`: a CSP hash source for one inline script (newlines normalized as the HTML parser does). */
export const scriptHash = (text: string) => `'sha256-${createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('base64')}'`;
/** `widget_page::inline_scripts`: each `<script>` element's raw text. */
export function inlineScripts(html: string): string[] {
  // ASCII only, as the app's `to_ascii_lowercase`: full Unicode lowercasing can change string length.
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const ends = (c: string | undefined) => c !== undefined && '>/ \t\n\r\f'.includes(c);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const found = lower.indexOf('<script', from);
    if (found < 0) break;
    const after = found + 7;
    if (!ends(lower[after])) {
      from = after;
      continue;
    }
    const gt = lower.indexOf('>', after);
    if (gt < 0) break;
    const body = gt + 1;
    let at = body;
    let end = html.length;
    for (;;) {
      const k = lower.indexOf('</script', at);
      if (k < 0) break;
      if (ends(lower[k + 8])) {
        end = k;
        break;
      }
      at = k + 1;
    }
    out.push(html.slice(body, end));
    from = end;
  }
  return out;
}

/** `widget_page::csp`: the artifact default with connect-src and img-src widened to each approved host; for a page that
 * can act (`act` is its entry, v1b-34 r2) scripts only by hash: the bridge key, the bootstrap, the entry's own. */
export function webCsp(hosts: string[], act?: string): string | null {
  if (!hosts.every((h) => /^[a-z0-9.-]{1,253}$/.test(h) && h.includes('.'))) return null;
  const sources = hosts.map((h) => ` https://${h}`).join('');
  const hashes = act === undefined ? [] : [...new Set([BRIDGE_KEY, BOOTSTRAP, ...inlineScripts(act)].map(scriptHash))];
  const base =
    act === undefined
      ? CSP_DEFAULT
      : CSP_DEFAULT.replace(/script-src [^;]*;/, `script-src ${hashes.join(' ')};`).replace('worker-src blob:', "worker-src 'none'");
  return base.replace("connect-src 'none'", hosts.length ? `connect-src${sources}` : "connect-src 'none'").replace('img-src data: blob:;', `img-src data: blob:${sources};`);
}

/** Same insertion rule as `with_bootstrap` in artifacts/mod.rs (head, else html, else after the doctype). */
function withBootstrap(body: string) {
  const lower = body.toLowerCase();
  const tagEnd = (name: string) => {
    const m = new RegExp(`${name}[\\s>/]`).exec(lower);
    return m ? lower.indexOf('>', m.index) + 1 : -1;
  };
  let at = tagEnd('<head');
  if (at < 0) at = tagEnd('<html');
  if (at < 0 && /^\s*<!doctype/.test(lower)) at = lower.indexOf('>') + 1;
  if (at < 0) at = 0;
  return `${body.slice(0, at)}<script>${BOOTSTRAP}</script>${body.slice(at)}`;
}

/** One request on the core's owner socket, as the app's `core_call` sends it. */
export function coreCall(home: string, request: object): Promise<{ Ok?: any; Err?: string }> {
  return new Promise((ok, fail) => {
    const s = net.connect(path.join(home, 'core.sock'));
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(home, 'core.token'), 'utf8').trim(), request }) + '\n'));
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) (s.destroy(), ok(JSON.parse(buf)));
    });
    s.on('error', fail);
  });
}

export type Served = { id: string; status: number; hash?: string; csp?: string };
/** One library in the lockfile (ARTIFACTLIBS, v2-10c): the CDN url a page names, pinned to these exact bytes. */
export type PinnedLib = { url: string; bytes: string };
/** `Libs::rewrite` / `/lib/<sha384>` of artifacts/libs.rs. Playwright cannot load `nunchiro-artifact://`, so the stand-in
 * serves the cache from the window's own origin and swaps that origin into the policy's one path source (as
 * fixtures/libs/server.ts does for artifact pages). A view-only page gets its pinned tags rewritten; an act page
 * (no path source in its policy) is served untouched, so its tags stay CDN urls the policy blocks. */
export const sha384Of = (text: string) => createHash('sha384').update(text).digest('hex');
/** The pin rewrite of a view-only page, as `Libs::rewrite`: a pinned url inside a `<script ... src="URL">` tag becomes
 * `<origin>/lib/<sha384>`; the same text anywhere else stays. */
export const rewritePinned = (html: string, pins: PinnedLib[], origin: string) =>
  pins.reduce(
    (h, l) => h.replace(new RegExp(`(<script\\b[^>]*?\\bsrc=)"${l.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'gi'), (_, tag: string) => `${tag}"${origin}/lib/${sha384Of(l.bytes)}"`),
    html,
  );
const LIB_SOURCE = 'nunchiro-artifact://localhost/lib/';
export async function installWidgetHost(page: Page, home: string, pins: PinnedLib[] = []) {
  const requests: object[] = [];
  const served: Served[] = [];
  const cache = new Map(pins.map((l) => [sha384Of(l.bytes), l.bytes]));
  await page.route(/\/lib\/[0-9a-f]{96}$/, (route) => {
    const bytes = cache.get(new URL(route.request().url()).pathname.split('/').pop()!);
    return bytes === undefined
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, headers: { 'Content-Type': 'text/javascript', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' }, body: bytes });
  });
  await page.route(/\/__widget\/[^/?]+$/, async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    const m = /^w-(.+)-([0-9a-f]{16})(-act)?$/.exec(id);
    const request = { op: 'widget_page', name: m?.[1] ?? '' };
    const reply = m ? (requests.push(request), await coreCall(home, request)) : {};
    const p = reply.Ok?.page;
    // review-34: an id is served only under the grant it was framed with.
    const csp = p && p.name === m![1] && p.hash.startsWith(m![2]) && p.act === (m![3] === '-act') ? webCsp(p.network, p.act ? p.entry : undefined) : null;
    const origin = new URL(route.request().url()).origin;
    if (!csp) {
      served.push({ id, status: 404 });
      return route.fulfill({ status: 404, body: '' });
    }
    served.push({ id, status: 200, hash: p.hash, csp });
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp.replace(LIB_SOURCE, `${origin}/lib/`), // only the origin of the path source differs from the app's
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
      body: first(withBootstrap(csp.includes(LIB_SOURCE) ? rewritePinned(p.entry as string, pins, origin) : p.entry)),
    });
  });
  await page.addInitScript(() => {
    window.__NUNCHIRO_WIDGET_HOST__ = { src: (id: string) => `${location.origin}/__widget/${encodeURIComponent(id)}` };
  });
  return { requests, served };
}

/** Every request the window sends the core over its WebSocket (the window half of the core request log). */
export function windowRequests(page: Page) {
  const ops: Record<string, unknown>[] = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') return;
      try {
        const r = JSON.parse(f.payload).request;
        if (r) ops.push(r);
      } catch {
        // Not JSON: not a request.
      }
    }),
  );
  return ops;
}
