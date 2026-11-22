// Shared setup for the Search specs: the fixture project (its `gitignore` copied in as `.gitignore`, which the repo's
// own git would otherwise apply), a `cat` shell session in it, and the window open on the ⌕ sidebar. Every socket
// frame passes through a recording proxy, so a test can count `files_search` requests and hold or replace a reply.
import type { Page, WebSocketRoute } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, type Core } from '../../fixtures';

export const PROJECT = path.join(import.meta.dirname, 'project');
export const KOREAN_NAME = '한글 노트 📝.md';

export interface SearchRequest {
  id: number;
  root: string;
  query: string;
}
/** Return a reply frame to send instead, `null` to send nothing now, or `undefined` to pass the core's reply. */
export type Hook = (req: SearchRequest, reply: string) => string | null | undefined;

export interface Wire {
  searches: SearchRequest[];
  hook: Hook | null;
  replies: Map<number, string>;
  /** Sends a held reply to the window. */
  deliver: (reply: string) => void;
}

export async function proxy(page: Page): Promise<Wire> {
  const wire: Wire = { searches: [], hook: null, replies: new Map(), deliver: () => {} };
  const asked = new Map<number, SearchRequest>();
  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer();
    wire.deliver = (m) => ws.send(m);
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const f = JSON.parse(m);
        if (f.request?.op === 'files_search') {
          const r = { id: f.id, root: f.request.root, query: f.request.query };
          wire.searches.push(r);
          asked.set(f.id, r);
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m === 'string') {
        const id = (JSON.parse(m) as { id?: number }).id;
        const req = id === undefined ? undefined : asked.get(id);
        if (req) {
          wire.replies.set(req.id, m);
          const out = wire.hook?.(req, m);
          if (out === null) return;
          if (out !== undefined) return ws.send(out);
        }
      }
      ws.send(m);
    });
  });
  return wire;
}

/** The fixture project in a session's folder, the proxy, and the window open on the ⌕ sidebar. */
// `direct` skips the proxy: forwarded `nunchiro layout` commands get no answer through a routed socket.
export async function setup(page: Page, core: Core, opts: { name?: string; extra?: (dir: string) => void; direct?: boolean } = {}) {
  const dir = core.project(opts.name ?? 'search');
  fs.cpSync(PROJECT, dir, { recursive: true });
  fs.renameSync(path.join(dir, 'gitignore'), path.join(dir, '.gitignore'));
  opts.extra?.(dir);
  const s = core.shell(dir, opts.name ?? 'search');
  const wire: Wire = opts.direct ? { searches: [], hook: null, replies: new Map(), deliver: () => {} } : await proxy(page);
  await openWindow(page, {}, core);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(field(page)).toBeVisible();
  return { dir, s, wire };
}

export const panel = (page: Page) => page.locator('.sbar .spanel');
export const field = (page: Page) => panel(page).getByRole('searchbox');
export const hits = (page: Page) => panel(page).getByRole('option');
export const hit = (page: Page, p: string, line: number) => panel(page).locator(`.hit[data-path="${p}"][data-line="${line}"]`);
export const status = (page: Page) => panel(page).locator('.sstat');
/** Every listed hit as `path:line`, in order. */
export const listed = (page: Page) => hits(page).evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.path}:${(e as HTMLElement).dataset.line}`));

export async function search(page: Page, q: string) {
  await field(page).fill(q);
  await field(page).press('Enter');
}
