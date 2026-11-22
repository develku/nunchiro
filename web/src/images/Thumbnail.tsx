// v1b-05: chat thumbnails from the transcript. Claude base64 blocks and Codex `data:` URLs render directly; Codex
// local paths and Nunchiro's saved paths are read through the core's confined `file_read`, never from the
// webview. Anything else (a remote URL, a path outside the readable roots, bytes that are not an image) is a
// named placeholder in the same reserved box, never a broken image.
// The decode-once effect with an `active` guard and the image fallback are adapted from T3 Code
// `apps/web/src/components/chat/ComposerImageThumbnail.tsx`, commit d14ace8; the click-to-open full-size viewer
// from MonoCode `AttachmentChip.tsx` (`ImageLightbox`), commit 26465c6.
// MIT License, Copyright (c) 2026 T3 Tools Inc.; MIT License, Copyright (c) 2026 Nick.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { useEffect, useRef, useState } from 'react';
import type { CoreClient } from '../api';
import type { Session } from '../types';
import { b64, sentThumbs, sniff, thumbnail } from './attach';
import { useHtmlLangT } from '../i18n/lib/useHtmlLangT';
import './images.css';
import { docT, lineError } from '../errors';

/** `at` (V2-10a): where a Markdown image path was scoped to, fixed by `mdSource`; null when it may not be read. */
export type Source = { type: string; media_type?: string; data?: string; url?: string; path?: string; at?: Where | null };
type Where = { root: string; path: string };
type Size = [w: number, h: number];

/** Set by the window on every render: the core to read through and the sessions whose folders are roots. */
export const imageScope: { core: CoreClient | null; sessions: Session[] } = { core: null, sessions: [] };

/** A path Nunchiro saved: `<home>/images/<session>/<sha256>.<ext>`, read through the `data` root. */
const SAVED = /^\/(?:[^/]+\/)*(images\/([A-Za-z0-9-]{1,80})\/[0-9a-f]{64}\.(?:png|jpg|gif|webp))$/;
/** V2-10a: a file in a session's artifact folder, `<home>/artifacts/<session>/<rel>`, read through the `data` root.
 * shortcut: only folders named after a listed session match (a resumed run's older folder id does not); match the
 * core's artifact folder id once sessions carry it. */
const ARTIFACT = /^\/(?:[^/]+\/)*(artifacts\/([A-Za-z0-9-]{1,80})\/.+)$/;

/** Lines of a user message that are exactly a saved image path: the composer's prompt form. */
export function savedPaths(text: string): Source[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => SAVED.test(l))
    .map((path) => ({ type: 'path', path }));
}

type Loaded = { src: string; size?: Size } | { problem: string };
const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/;

/** V2-10a: decoding allocates 4 bytes a pixel, and 2 MB of PNG can claim 30000×30000; nothing over this is decoded. */
const MAX_PIXELS = 40_000_000;

/** Width and height as the header states them (PNG IHDR, GIF screen, WebP VP8/VP8L/VP8X, JPEG SOFn), or null. */
export function pixels(b: Uint8Array): Size | null {
  const at = (i: number) => {
    if (i >= b.length) throw new RangeError('short header');
    return b[i];
  };
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const le24 = (i: number) => le16(i) | (at(i + 2) << 16);
  const tag = (i: number, t: string) => [...t].every((c, k) => b[i + k] === c.charCodeAt(0));
  try {
    switch (sniff(b)) {
      case 'image/png':
        return tag(12, 'IHDR') ? [((be16(16) << 16) | be16(18)) >>> 0, ((be16(20) << 16) | be16(22)) >>> 0] : null;
      case 'image/gif': {
        // A frame may be larger than the logical screen and the decoder grows to it: the largest of all counts.
        const size: Size = [le16(6), le16(8)];
        const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
        const blocks = (i: number) => {
          while (at(i)) i += at(i) + 1;
          return i + 1;
        };
        for (let i = 13 + table(at(10)); ; ) {
          const kind = at(i);
          if (kind === 0x3b) return size;
          if (kind === 0x21) i = blocks(i + 2);
          else if (kind === 0x2c) {
            size[0] = Math.max(size[0], le16(i + 1) + le16(i + 5));
            size[1] = Math.max(size[1], le16(i + 3) + le16(i + 7));
            i = blocks(i + 11 + table(at(i + 9)));
          } else return null;
        }
      }
      case 'image/webp': {
        if (tag(12, 'VP8X')) return [1 + le24(24), 1 + le24(27)];
        if (tag(12, 'VP8L') && at(20) === 0x2f) {
          const n = (le16(21) | (le16(23) << 16)) >>> 0;
          return [1 + (n & 0x3fff), 1 + ((n >>> 14) & 0x3fff)];
        }
        return tag(12, 'VP8 ') ? [le16(26) & 0x3fff, le16(28) & 0x3fff] : null;
      }
      case 'image/jpeg':
        // Segments after SOI until a frame header; DHT (C4), JPG (C8) and DAC (CC) share the range but are not frames.
        for (let i = 2; ; ) {
          if (at(i) !== 0xff) return null;
          const m = at(i + 1);
          if (m === 0xff) i += 1;
          else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2;
          else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [be16(i + 7), be16(i + 5)];
          else if (m === 0xd9 || m === 0xda) return null;
          else i += 2 + be16(i + 2);
        }
    }
  } catch {
    // A header cut short has no size.
  }
  return null;
}

/** The image as a `data:` URL when its header states a size within the cap, else why not. */
function checked(bytes: Uint8Array, data: string, want?: string): Loaded {
  const type = sniff(bytes);
  if (!type || (want && want !== type)) return { problem: 'not an image' };
  const size = pixels(bytes);
  if (!size || !size[0] || !size[1]) return { problem: 'image size unreadable' };
  if (size[0] * size[1] > MAX_PIXELS) return { problem: 'too large to preview (over 40 megapixels)' };
  return { src: `data:${type};base64,${data}`, size };
}

function fromBase64(type: string | undefined, data: string | undefined): Loaded {
  try {
    // The whole image: a GIF's frame sizes run to its end, and a JPEG frame header can follow long metadata.
    const head = Uint8Array.from(atob(data ?? ''), (c) => c.charCodeAt(0));
    const l = checked(head, data ?? '', type);
    return 'problem' in l && l.problem === 'not an image' ? { problem: 'image could not be decoded' } : l;
  } catch {
    return { problem: 'image could not be decoded' };
  }
}

// `.` and `..` segments can lead out of a folder the path seems to start in: not readable, not asked.
const plainAbs = (path: string) => path.startsWith('/') && !path.split('/').some((p) => p === '.' || p === '..');
/** A session folder as a prefix; a folder of `/` is no root (every absolute path would be inside it). */
const folderOf = (s: Session) => {
  const dir = s.cwd.replace(/\/+$/, '');
  return dir ? dir + '/' : null;
};

/** Where a path can be read: the data root for saved images, else the folder of a session that contains it. */
function root(path: string): Where | null {
  if (!plainAbs(path)) return null;
  const saved = SAVED.exec(path);
  if (saved) return { root: 'data', path: saved[1] };
  const art = ARTIFACT.exec(path);
  if (art && imageScope.sessions.some((s) => s.id === art[2])) return { root: 'data', path: art[1] };
  let best: { s: Session; dir: string } | null = null;
  for (const s of imageScope.sessions) {
    const dir = folderOf(s);
    if (dir && path.startsWith(dir) && (!best || dir.length > best.dir.length)) best = { s, dir };
  }
  return best ? { root: best.s.id, path: path.slice(best.dir.length) } : null;
}

/**
 * V2-10a: a Markdown image address as a path source scoped to its message's session: relative paths join that
 * session's folder, and only that folder or the session's own saved images and artifacts are read.
 * shortcut: the data folder is matched by path shape (`…/images/<session>/…`), as the window does not know where it
 * is; the title names the data-folder file read. Anchor to the real folder once the core reports it.
 */
export function mdSource(src: string, session: Session | null): Source {
  let path = src;
  try {
    path = decodeURI(src);
  } catch {
    // Kept as written: the core finds no such file.
  }
  if (session && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith('/')) path = `${session.cwd.replace(/\/+$/, '')}/${path.replace(/^(\.\/)+/, '')}`;
  if (!session || !plainAbs(path)) return { type: 'path', path, at: null };
  const data = SAVED.exec(path) ?? ARTIFACT.exec(path);
  if (data && data[2] === session.id) return { type: 'path', path, at: { root: 'data', path: data[1] } };
  const dir = folderOf(session);
  return { type: 'path', path, at: dir && path.startsWith(dir) ? { root: session.id, path: path.slice(dir.length) } : null };
}

/** The readable file behind a path source, or null (bytes in the transcript, or outside the roots). v1b-06 */
export const fileOf = (s: Source): Where | null => (s.type !== 'path' || !s.path ? null : s.at !== undefined ? s.at : root(s.path));

/** The file a path source reads, as the user should see it. */
const readName = (s: Source) => {
  const f = fileOf(s);
  return f?.root === 'data' ? `Nunchiro data folder: ${f.path}` : (s.path ?? '');
};

async function readPath(where: Where | null): Promise<Loaded> {
  if (!where) return { problem: 'outside the readable folders' };
  if (!imageScope.core) return { problem: 'core not connected' };
  try {
    const file = (await imageScope.core.request({ op: 'file_read', ...where })) as { kind: string; too_large: boolean; data: number[] | null };
    if (file.too_large) return { problem: 'too large to preview (over 2 MB)' };
    if (file.kind !== 'image' || !file.data) return { problem: 'not an image' };
    const bytes = Uint8Array.from(file.data);
    return checked(bytes, b64(bytes));
  } catch (e) {
    return { problem: lineError(docT(), e) };
  }
}

/** The full image as a `data:` URL, or why it is not shown. */
export function load(source: Source): Promise<Loaded> {
  if (source.type === 'base64') return Promise.resolve(fromBase64(source.media_type, source.data));
  if (source.type === 'url') {
    const m = DATA_URL.exec(source.url ?? '');
    return Promise.resolve(m ? fromBase64(m[1], m[2]) : { problem: 'remote image not loaded' });
  }
  if (source.type === 'path' && source.path) return readPath(fileOf(source));
  return Promise.resolve({ problem: 'unknown image source' });
}

/** A `data:` URL as a Blob, without fetch (the window CSP's connect-src does not allow `data:`). */
function blobOf(src: string) {
  const [head, data] = src.split(',');
  return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: head.slice(5, head.indexOf(';')) });
}

const THUMB: Size = [62, 42];
/** V2-10a inline images: at most 240 px high (R8 B2 look at chat width); decoded at most twice this. */
const INLINE: Size = [320, 240];

const keyOf = (s: Source) => (s.type === 'path' ? `p:${s.path}` : s.type === 'url' ? `u:${s.url}` : `b:${s.data?.length}:${s.data?.slice(0, 64)}:${s.data?.slice(-64)}`);
/** Downscaled thumbnails, so a row scrolled back into the virtual list does not read the file again. */
const cache = new Map<string, Promise<Loaded>>();
/** Header sizes seen, so a row scrolled back reserves the image's own box before anything resolves. */
const sizes = new Map<string, Size>();
/** The box an image of `size` fills inside `box`, never larger than the image. */
const fit = ([w, h]: Size, [bw, bh]: Size): Size => {
  const k = Math.min(1, bw / w, bh / h);
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
};
function thumbOf(source: Source, [w, h]: Size): Promise<Loaded> {
  const k = `${w}:${h}:${keyOf(source)}`;
  let p = cache.get(k);
  if (!p) {
    const sent = w === THUMB[0] && h === THUMB[1] && source.path && sentThumbs.get(source.path);
    p = sent
      ? Promise.resolve({ src: sent })
      : load(source).then(async (l) => {
          if (!('src' in l)) return l;
          if (l.size) sizes.set(keyOf(source), l.size);
          try {
            return { src: await thumbnail(blobOf(l.src), w, h), size: l.size };
          } catch {
            return { problem: 'image could not be decoded' };
          }
        });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(k, p);
  }
  return p;
}

export const nameOf = (s: Source) => s.path?.split('/').pop() ?? (s.media_type ? s.media_type.replace('image/', '') + ' image' : 'image');

/**
 * The click seam: null, or an opener returning false, opens the built-in full-size viewer. Ticket 06 re-points the
 * click to Preview by setting `imageOpener.open`; `from` is the thumbnail, to give focus back to.
 */
export const imageOpener: { open: ((source: Source, from: HTMLElement) => boolean) | null } = { open: null };

function Viewer({ source, onClose }: { source: Source; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useHtmlLangT(); // ticket 508
  const [state, setState] = useState<Loaded | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    let live = true;
    void load(source).then((l) => live && setState(l));
    return () => {
      live = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- opened once per click
  const name = nameOf(source);
  // Native modal <dialog>: focus stays inside, Esc arrives as `cancel`.
  return (
    <dialog ref={ref} className="iview" aria-label={t('rest.widgets.image.aria', { name })} onCancel={(e) => (e.preventDefault(), onClose())} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="ivbar">
        <span className="iname">{name}</span>
        <button type="button" className="btn" onClick={onClose} autoFocus>
          {t('rest.widgets.close')} <span className="k">esc</span>
        </button>
      </div>
      {state && 'src' in state ? <img src={state.src} alt={name} /> : <p className="dim">{state ? state.problem : t('rest.widgets.image.loading')}</p>}
    </dialog>
  );
}

/** V2-10a: a Markdown image that is not shown, as a muted chip naming the path and why. */
export function PathChip({ path, problem }: { path: string; problem: string }) {
  const t = useHtmlLangT(); // ticket 508
  return (
    <span className="mdimg off" role="img" aria-label={t('rest.widgets.image.problemAria', { name: path, problem })} title={problem}>
      {path}
    </span>
  );
}

/** `inline` (V2-10a): a Markdown image in the 320×240 box, read once near the view; refused, it is a muted path chip. */
export function Thumbnail({ source, inline = false }: { source: Source; inline?: boolean }) {
  const t = useHtmlLangT(); // ticket 508
  const [state, setState] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);
  const [near, setNear] = useState(!inline);
  const ref = useRef<HTMLButtonElement>(null);
  const key = keyOf(source);
  // Inline box: the image's own size when a header was seen before; else 320×240, then only the width follows the
  // image, so its row's height never changes while the reader is looking.
  const [known] = useState(() => sizes.get(key));
  const got = state && 'src' in state ? state.size : undefined;
  const box = !inline ? undefined : known ? fit(known, INLINE) : got && [fit(got, INLINE)[0], INLINE[1]];
  useEffect(() => {
    if (near || !ref.current) return;
    // The chat's scroller as root, or its clipping would hide the 400 px margin and every image would load only once in view.
    const root = ref.current.closest('.cscroll');
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setNear(true), { root, rootMargin: '400px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    void thumbOf(source, inline ? INLINE : THUMB).then((l) => live && setState(l));
    return () => {
      live = false;
    };
    // The source object is rebuilt on every render; its key is what matters.
  }, [key, near]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = nameOf(source);
  if (state && 'problem' in state && inline) return <PathChip path={readName(source)} problem={state.problem} />;
  if (state && 'problem' in state)
    return (
      <div className="thumb iph" data-slot="thumbnail" role="img" aria-label={t('rest.widgets.image.problemAria', { name, problem: state.problem })} title={`${name}: ${state.problem}`}>
        <span aria-hidden>▨ {state.problem}</span>
      </div>
    );
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={inline ? 'thumb ithumb inline' : 'thumb ithumb'}
        style={box && { width: box[0], height: box[1] }}
        title={inline ? readName(source) : undefined}
        data-slot="thumbnail"
        aria-label={t('rest.widgets.image.open', { name })}
        disabled={!state}
        onClick={() => imageOpener.open?.(source, ref.current!) || setOpen(true)}
      >
        {state && <img src={state.src} alt={name} />}
      </button>
      {/* Focus goes back once the modal is gone: while it is open everything outside it is inert. */}
      {open && <Viewer source={source} onClose={() => (setOpen(false), requestAnimationFrame(() => ref.current?.focus()))} />}
    </>
  );
}
