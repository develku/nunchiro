// v1b-05: page helpers shared by the thumbnails specs: generated images, paste/drop with the event's own data
// (never the system clipboard) and a log of every request frame the window sends to the core.
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __png: (w: number, h: number, seed: number, name: string) => Promise<File>;
    __file: (bytes: number[], name: string, type: string, pad?: number) => File;
    __frames: { op: string; text?: string; path?: string; at: number }[];
  }
}

/** In the page: a PNG of random pixels (incompressible, so its size is about w·h·3) and a raw file maker. */
export const helpers = () => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (kind: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set([...kind].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  window.__png = async (w, h, seed, name) => {
    const raw = new Uint8Array(h * (w * 3 + 1));
    let x = seed || 1;
    for (let i = 0; i < raw.length; i++) {
      if (i % (w * 3 + 1) === 0) continue; // filter byte 0
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      raw[i] = x & 0xff;
    }
    const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, w);
    new DataView(ihdr.buffer).setUint32(4, h);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([sig, chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array())], name, { type: 'image/png' });
  };
  window.__file = (bytes, name, type, pad = 0) => new File([new Uint8Array(bytes), new Uint8Array(pad)], name, { type });
  // Every request frame the window sends to the core, in order.
  window.__frames = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    try {
      const f = JSON.parse(String(data));
      if (f.request?.op) window.__frames.push({ op: f.request.op, text: f.request.text, path: f.request.path, at: performance.now() });
    } catch {
      // Not JSON: not a request.
    }
    return send.call(this, data);
  };
};

export type Spec = { png: [number, number, number, string] } | { bytes: number[]; name: string; type: string; pad?: number };

/** Dispatches a paste (or drop) carrying `files` on the composer, as the webview does for the user's own action. */
export async function give(page: Page, files: Spec[], kind: 'paste' | 'drop' = 'paste') {
  await page.locator('.cbox textarea').evaluate(
    async (el, { files, kind }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add('png' in f ? await window.__png(...f.png) : window.__file(f.bytes, f.name, f.type, f.pad));
      if (kind === 'paste') el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      else {
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }
    },
    { files, kind },
  );
}

export const frames = (page: Page) => page.evaluate(() => window.__frames);
export const ptyWrites = async (page: Page) => (await frames(page)).filter((f) => f.op === 'send_text' || f.op === 'send_keys');
