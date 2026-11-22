// Stand-ins for the app side of the artifact sandbox, so Playwright (which cannot load Tauri's custom
// scheme) can still exercise the frame. The policy strings are the very files the Rust handler embeds.
import { buildQuiet } from './vite-build';
import react from '@vitejs/plugin-react';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(WEB, '..');
const ART = path.join(REPO, 'app/src-tauri/src/artifacts');
export const CSP_DEFAULT = fs.readFileSync(path.join(ART, 'csp-default.txt'), 'utf8').trim();
export const CSP_NETWORK = fs.readFileSync(path.join(ART, 'csp-network.txt'), 'utf8').trim();
const BOOTSTRAP = fs.readFileSync(path.join(ART, 'bootstrap.js'), 'utf8').trim();
export const FIXTURES = path.join(WEB, 'tests/fixtures/artifacts');
const TAURI_CSP: string = JSON.parse(fs.readFileSync(path.join(REPO, 'app/src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;

const listen = (s: net.Server | http.Server) =>
  new Promise<number>((ok) => s.listen(0, '127.0.0.1', () => ok((s.address() as net.AddressInfo).port)));

/** A loopback listener that only counts connections: nothing may ever connect to it. */
export async function canary() {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((s) => {
    connections++;
    sockets.add(s);
    s.destroy();
  });
  const port = await listen(server);
  return { port, count: () => connections, close: () => new Promise<void>((ok) => server.close(() => ok())) };
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

export const hashOf = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Serves `/<id>` like the scheme handler: the policy follows the grant for the current hash only. */
export async function artifactServer(vars: Record<string, string>) {
  const content = new Map<string, string>();
  const grants = new Map<string, string>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').split('?')[0].slice(1));
    const body = content.get(id);
    if (req.method !== 'GET' || body === undefined) return void res.writeHead(404).end();
    const hash = hashOf(body);
    hits.push(`${id}:${grants.get(id) === hash ? 'wide' : 'default'}`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': grants.get(id) === hash ? CSP_NETWORK : CSP_DEFAULT,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(withBootstrap(body));
  });
  const port = await listen(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    /** Loads a fixture file under an id; returns the id and hash the frame is given. */
    set(id: string, file: string) {
      let text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
      content.set(id, text);
      return { id, hash: hashOf(text) };
    },
    setText(id: string, text: string) {
      content.set(id, text);
      return { id, hash: hashOf(text) };
    },
    grant: (id: string, hash: string) => void grants.set(id, hash),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** Builds the harness page once and serves it under the app's own CSP (frame-src narrowed to the artifact origin). */
export async function harnessServer(artifactOrigin: string) {
  const outDir = path.join(REPO, '.scratch/sandbox-harness', String(process.pid));
  await buildQuiet({
    root: path.join(WEB, 'tests/sandbox-harness'),
    plugins: [react()],
    logLevel: 'error',
    configFile: false,
    build: { outDir, emptyOutDir: true, target: 'safari16' },
  });
  const csp = TAURI_CSP.replace(/frame-src [^;]*/, `frame-src ${artifactOrigin}`);
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = (req.url ?? '/').split('?')[0];
    const file = path.join(outDir, rel === '/' ? 'index.html' : path.normalize(rel));
    if (!file.startsWith(outDir) || !fs.existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp });
    res.end(fs.readFileSync(file));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/`,
    csp,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        fs.rmSync(outDir, { recursive: true, force: true });
      }),
  };
}
