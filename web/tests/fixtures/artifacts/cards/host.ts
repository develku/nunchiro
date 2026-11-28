// Browser stand-in for the app's `artifact_open` (v1b-09's CoreContent) and scheme, for chat-card tests. Playwright
// cannot load Tauri's custom scheme, so the frame is served by 04's test server with the same CSP files. Like
// CoreContent, the bytes come only from the real core's `file_read` reply (HTML or SVG text, never over 2 MB), and
// the id is stable for `(root, path)` so a reopened file keeps its id while its bytes keep their hash.
import crypto from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import type { artifactServer } from '../../../sandbox-server';

type Art = Awaited<ReturnType<typeof artifactServer>>;

export const idFor = (root: string, path: string) =>
  'f' + crypto.createHash('sha256').update(`nunchiro-file-artifact-v1\0${root.length}:${root}${path}`).digest('hex').slice(0, 32);

/** Ticket 1088: an HTML or SVG card is one line by default; its chevron (any language) shows the frame in place. */
export async function showFrame(card: Locator) {
  await card.locator('.af-chip.fold').click();
  await expect(card).toHaveClass(/\bframe\b/);
  await expect(card).not.toHaveAttribute('data-state', 'loading');
  // The frame opens under the pointer that pressed the chip, and while the pointer is on a frame its library cards stay
  // folded behind the bar's chip (ArtifactFrame `frozen`, by design). The pointer leaves, as a user's would.
  await card.page().mouse.move(1, 1);
}

export async function installHost(page: Page, art: Art, opened: string[] = []) {
  // The dev page's own CSP allows frames from 'self' only (the app's adds the artifact scheme), so frames load from
  // a same-origin path that is forwarded to 04's server with its CSP headers untouched; still sandboxed, so opaque.
  await page.route(/\/__artifact\/[^/]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({ response: await route.fetch({ url: `${art.origin}/${id}` }) });
  });
  await page.exposeFunction('__artifactRegister', (root: string, path: string, text: string) => {
    opened.push(`${root}:${path}`);
    return art.setText(idFor(root, path), text);
  });
  await page.exposeFunction('__artifactGrant', (id: string, hash: string) => art.grant(id, hash));
  await page.addInitScript(() => {
    type W = Window & { __artifactRegister: (r: string, p: string, t: string) => Promise<{ id: string; hash: string }>; __artifactGrant: (i: string, h: string) => Promise<void> };
    const w = window as unknown as W;
    let ws: WebSocket | null = null;
    let next = 1;
    const pending = new Map<number, [(v: any) => void, (e: Error) => void]>();
    const socket = () =>
      new Promise<WebSocket>((ok, fail) => {
        if (ws?.readyState === WebSocket.OPEN) return ok(ws);
        const boot = window.__NUNCHIRO__!;
        const s = new WebSocket(`ws://127.0.0.1:${boot.port}/ws`, ['nunchiro.v1', `nunchiro.token.${boot.token}`]);
        s.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data));
          const p = typeof m.id === 'number' && pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
          if (m.response && 'Ok' in m.response) p[0](m.response.Ok);
          else p[1](new Error(String(m.response?.Err)));
        };
        s.onopen = () => ok((ws = s));
        s.onerror = () => fail(new Error('core disconnected'));
      });
    const call = async (request: object) => {
      const s = await socket();
      const id = next++;
      return new Promise<any>((ok, fail) => {
        pending.set(id, [ok, fail]);
        s.send(JSON.stringify({ id, request }));
      });
    };
    window.__NUNCHIRO_ARTIFACT_HOST__ = {
      async open(root, path) {
        if ((window as unknown as { __artifactNoCommand?: boolean }).__artifactNoCommand) throw 'Command artifact_open not found';
        const r = await call({ op: 'file_read', root, path });
        if (r?.type !== 'file' || !['html', 'svg'].includes(r.kind) || r.too_large || typeof r.text !== 'string') throw new Error('not an HTML file the core can read');
        return w.__artifactRegister(root, path, r.text);
      },
      src: (id) => `${location.origin}/__artifact/${id}`,
      grant: (id, hash) => w.__artifactGrant(id, hash),
    };
  });
}
