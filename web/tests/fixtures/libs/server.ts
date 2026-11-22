// V2-10c stand-ins for the app (ticket 27b) and the core (ticket 27a), so Playwright can drive the card: the page is
// served with pinned tags rewritten to `/lib/<sha384>` under the contract's CSP shape (the five hosts gone, the `/lib/`
// path source added), and Allow fetches once from a loopback "CDN" origin. Loopback only; no real CDN is contacted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { CSP_DEFAULT, CSP_NETWORK } from '../../sandbox-server';
import type { LibCard, LibCards } from '../../../src/sandbox/libs';

const ART = path.resolve(import.meta.dirname, '../../../../app/src-tauri/src/artifacts');
const BOOTSTRAP = fs.readFileSync(path.join(ART, 'bootstrap.js'), 'utf8').trim();
const HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdn.tailwindcss.com', 'code.jquery.com'];
export const CHART_STUB = 'function Chart(el){var c=el.getContext("2d");c.fillRect(10,10,50,30);Chart.drawn="ok"}';

const listen = (s: http.Server) => new Promise<number>((ok) => s.listen(0, '127.0.0.1', () => ok((s.address() as net.AddressInfo).port)));
const sha384 = (b: Buffer | string) => crypto.createHash('sha384').update(b).digest('hex');
export const hashOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** The contract's policy: no CDN host in script-src, only the `/lib/` path source (network on: today's + `/lib/`). */
export function libCsp(base: string, lib: string) {
  return base.replace(/script-src ([^;]*)/, (_, v: string) => `script-src ${v.split(' ').filter((s) => !HOSTS.some((h) => s === `https://${h}`)).join(' ')} ${lib}`);
}

/** cdnjs `/ajax/libs/<Lib>/<version>/<file>` only: enough for the fixtures. */
function tuple(url: string) {
  const u = new URL(url);
  const m = /^\/ajax\/libs\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
  return m && u.hostname === HOSTS[0] ? { host: u.hostname, library: m[1], version: m[2], file: m[3] } : null;
}

export async function libServer() {
  const pages = new Map<string, string>();
  const grants = new Map<string, string>();
  /** url -> pinned bytes (the lockfile and store). */
  const pins = new Map<string, Buffer>();
  /** id -> the one-view "Open with" and its token (V2-38: like the app, keyed by id, consumed only with `?view=`). */
  const once = new Map<string, { hash: string; url: string; sha: string; view: string }>();
  const served: string[] = [];
  /** The `view` of each page request, '' when it had none. */
  const views: string[] = [];
  const cdn = { files: new Map<string, string>(), hits: [] as string[], server: null as http.Server | null, origin: '' };

  const tags = (text: string) => [...text.matchAll(/<script src="(https:\/\/[^"]+)"(?: integrity="([^"]+)")?/g)].map((m) => ({ url: m[1], integrity: m[2] ?? null }));
  const art = http.createServer((req, res) => {
    const [url, query = ''] = (req.url ?? '').split('?');
    const lib = /^\/lib\/([0-9a-f]{96})$/.exec(url);
    if (lib) {
      const bytes = [...pins.values()].find((b) => sha384(b) === lib[1]);
      served.push(`lib:${lib[1].slice(0, 8)}`);
      if (!bytes) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'Content-Type': 'text/javascript', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).end(bytes);
    }
    const id = decodeURIComponent(url.slice(1));
    let text = pages.get(id);
    if (req.method !== 'GET' || text === undefined) return void res.writeHead(404).end();
    const hash = hashOf(text);
    const view = new URLSearchParams(query).get('view') ?? '';
    views.push(view);
    const held = once.get(id);
    if (held && view === held.view) once.delete(id);
    const swap = held && view === held.view && held.hash === hash ? held : undefined;
    for (const { url: u } of tags(text)) {
      const sha = swap?.url === u ? swap.sha : pins.has(u) ? sha384(pins.get(u)!) : null;
      if (sha) text = text.replaceAll(`src="${u}"`, `src="${origin}/lib/${sha}"`);
    }
    const wide = grants.get(id) === hash;
    served.push(`${id}:${wide ? 'wide' : 'default'}`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': libCsp(wide ? CSP_NETWORK : CSP_DEFAULT, `${origin}/lib/`),
      'Cache-Control': 'no-store',
    });
    res.end(text.replace('<head>', `<head><script>${BOOTSTRAP}</script>`));
  });
  const origin = `http://127.0.0.1:${await listen(art)}`;

  return {
    origin,
    served,
    views,
    cdn,
    pins,
    set(id: string, text: string) {
      pages.set(id, text);
      return { id, hash: hashOf(text) };
    },
    grant: (id: string, hash: string) => void grants.set(id, hash),
    /** Each test starts with no page, grant, pin or stored "Open with". */
    reset() {
      for (const m of [pages, grants, pins, once, cdn.files]) m.clear();
      served.length = 0;
      views.length = 0;
      cdn.hits.length = 0;
    },
    /** What `artifact_lib_cards` answers: a card per unpinned cdnjs tag in the served bytes, in page order. */
    cards(id: string, hash: string): LibCards {
      const text = pages.get(id);
      if (text === undefined || hashOf(text) !== hash) throw new Error('refused');
      const cards: LibCard[] = [];
      let pinned = 0;
      for (const { url, integrity } of tags(text)) {
        const t = tuple(url);
        if (!t) continue;
        if (pins.has(url)) {
          pinned++;
          continue;
        }
        const others = [...pins.keys()].map(tuple).filter((o) => o && o.library === t.library && o.file === t.file).map((o) => o!.version);
        cards.push({ url, ...t, listed: false, auto: false, other_versions: others, message: `\`${t.library}\` \`${t.version}\` is not on this Mac yet. Allow it to fetch it once; until then nothing is fetched.`, integrity });
      }
      return { cards, refused: [], pinned };
    },
    /** `libs_allow`: fetch once from the loopback origin and pin. */
    async allow(url: string) {
      if (pins.has(url)) return;
      const r = await fetch(`${cdn.origin}${new URL(url).pathname}`);
      if (r.status !== 200) throw new Error(`Could not reach \`${new URL(url).hostname}\`.`);
      pins.set(url, Buffer.from(await r.arrayBuffer()));
    },
    openWith(id: string, hash: string, url: string, sha: string) {
      const view = crypto.randomBytes(16).toString('hex');
      once.set(id, { hash, url, sha, view });
      return view;
    },
    entries: () => [...pins].map(([url, b]) => ({ ...tuple(url)!, path: new URL(url).pathname, sha384: sha384(b), sha512: '', size: b.length, fetched_at: 0, badge: 'unverified', first_requester: 'test' })),
    async startCdn() {
      cdn.server = http.createServer((req, res) => {
        cdn.hits.push(req.url ?? '');
        const body = cdn.files.get(req.url ?? '');
        if (body === undefined) return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(body);
      });
      cdn.origin = `http://127.0.0.1:${await listen(cdn.server)}`;
    },
    stopCdn: () => new Promise<void>((ok) => (cdn.server ? cdn.server.close(() => ok()) : ok())),
    close: () => new Promise<void>((ok) => art.close(() => ok())),
  };
}
export type LibServer = Awaited<ReturnType<typeof libServer>>;
