// v1b-05: images pasted or dropped in the composer. Only the paste or drop event's own data is read; the system
// clipboard is never read beyond it and never written. On the user's Enter each image is uploaded to the core in
// pieces (`image_put`), saved under the data folder, and its absolute path goes into the prompt.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { CoreClient } from '../api';
import { blobStore } from '../chat/blob-store';
import { inApp, mountNativeDrop } from './nativeDrop';
import { docT, lineError, rawError } from '../errors';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 10;
/** 192 KiB of bytes is 256 KiB of base64: one piece under the core's 1 MiB WebSocket cap. */
const PIECE = 192 * 1024;
const TYPES = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' } as const;
export type ImageType = keyof typeof TYPES;

export interface Chip {
  id: string;
  name: string;
  blob: Blob;
  /** Downscaled `data:` URL (the window CSP allows `data:` images, not `blob:`). */
  thumb: string;
  saving: boolean;
}

/** The type the bytes really are, by magic number; SVG, HTML and anything else is null. */
export function sniff(b: Uint8Array): ImageType | null {
  const at = (s: number, ...v: number[]) => v.every((x, i) => b[s + i] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** Downscaled to fit w×h (CSS pixels, drawn at 2x) as a PNG `data:` URL. */
export async function thumbnail(blob: Blob, w: number, h: number): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, (2 * w) / bitmap.width, (2 * h) / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/** Refuses with a message the composer shows; nothing becomes a chip unless it is a real image under the cap. */
export async function accept(file: File): Promise<Chip> {
  const name = file.name || 'image';
  if (!(file.type in TYPES)) throw new Error(`${name}: only PNG, JPEG, GIF or WebP images can be attached`);
  if (file.size > MAX_BYTES) throw new Error(`${name}: over the 20 MB image limit`);
  const real = sniff(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (real !== file.type) throw new Error(`${name}: the file is not the ${TYPES[file.type as ImageType]} image it says it is`);
  let thumb: string;
  try {
    thumb = await thumbnail(file, 22, 22);
  } catch {
    throw new Error(`${name}: the image could not be decoded`);
  }
  return { id: crypto.randomUUID(), name, blob: file, thumb, saving: false };
}

export function b64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads one image in pieces; the core checks order and the final sha256, then saves atomically. */
export async function upload(core: CoreClient, session: string, blob: Blob, signal: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  for (let offset = 0; ; offset += PIECE) {
    if (signal.aborted) throw new Error('cancelled');
    const last = offset + PIECE >= bytes.length;
    const reply = (await core.request({ op: 'image_put', session, upload: id, offset, chunk_b64: b64(bytes.subarray(offset, offset + PIECE)), last, sha256 })) as {
      path: string | null;
    };
    if (last) {
      if (!reply.path) throw new Error('the core did not save the image');
      return reply.path;
    }
  }
}

/** Saved path → chip thumbnail, so the chat shows what was sent even when the file is too large to read back. */
export const sentThumbs = new Map<string, string>();

// Ticket 371 item 24: unsent chips rest in the blob store, one record each, until they are sent or removed.
// ponytail: a chip left in a session that is later closed stays in the store (this hook has no session list). Sweep on load against the core's sessions if that piles up.
const CHIP = 'chip:';
const chipKey = (session: string, id: string) => `${CHIP}${session}:${id}`;
const unsaved = (e: unknown) => console.warn('an image chip change will not survive a reload', e); // the chip stays usable in memory
interface ChipRecord {
  session: string;
  id: string;
  file: File;
  at: number;
}

/** The chips left unsent, through accept() again so the magic-number check still applies. One that fails is named once and deleted: nothing else could remove it. */
async function restoreChips() {
  const chips: Record<string, Chip[]> = {};
  const problems: Record<string, string[]> = {};
  const records = (await blobStore.loadAll(CHIP)) as [string, ChipRecord][];
  for (const [key, r] of records.sort(([, a], [, b]) => a.at - b.at)) {
    try {
      (chips[r.session] ??= []).push({ ...(await accept(r.file)), id: r.id });
    } catch {
      (problems[r.session] ??= []).push(docT()('own.img.readBack', { name: r.file?.name || docT()('own.img.unnamed') }));
      blobStore.remove([key]).catch(unsaved);
    }
  }
  return { chips, problems };
}

/** Chips per session, the last refusal message, and the save that runs on Enter. */
export function useImages(core: CoreClient) {
  const [chips, setChips] = useState<Record<string, Chip[]>>({});
  const [error, setError] = useState<Record<string, string>>({});
  const aborts = useRef(new Map<string, AbortController>());
  /** Chips the user removed: a save in flight skips them (set synchronously, before any rerender). */
  const removed = useRef(new Set<string>());
  const latest = useRef(chips);
  latest.current = chips;
  const set = (session: string, f: (c: Chip[]) => Chip[]) => setChips((all) => ({ ...all, [session]: f(all[session] ?? []) }));

  useEffect(() => {
    void mountNativeDrop((session, message) => setError((all) => ({ ...all, [session]: message })));
    restoreChips().then(({ chips: back, problems }) => {
      for (const [session, list] of Object.entries(back)) set(session, (c) => [...list.filter((x) => !c.some((y) => y.id === x.id)), ...c].slice(0, MAX_IMAGES));
      for (const [session, list] of Object.entries(problems)) setError((all) => ({ ...all, [session]: list.join(' · ') }));
    }).catch((e) => console.warn('image chips could not be restored', e));
  }, []);

  const add = useCallback(async (session: string, files: File[]) => {
    const problems: string[] = [];
    const room = MAX_IMAGES - (latest.current[session]?.length ?? 0);
    if (files.length > room) problems.push(`up to ${MAX_IMAGES} images per message`);
    const ok: Chip[] = [];
    for (const f of files.slice(0, Math.max(0, room))) {
      try {
        ok.push(await accept(f));
      } catch (e) {
        problems.push(rawError(e));
      }
    }
    set(session, (c) => [...c, ...ok].slice(0, MAX_IMAGES));
    setError((all) => ({ ...all, [session]: problems.join(' · ') }));
    ok.forEach((c, i) => blobStore.write(chipKey(session, c.id), { session, id: c.id, file: c.blob as File, at: Date.now() + i } satisfies ChipRecord).catch(unsaved));
  }, []);

  const remove = useCallback((session: string, id: string) => {
    removed.current.add(id);
    aborts.current.get(id)?.abort();
    set(session, (c) => c.filter((x) => x.id !== id));
    blobStore.remove([chipKey(session, id)]).catch(unsaved);
  }, []);

  /**
   * Saves the chips in order, skipping any the user removes meanwhile (also the one uploading). Rejects, keeping
   * the chips, if one fails or if every chip was removed: then nothing is sent.
   */
  const save = useCallback(
    async (session: string): Promise<{ paths: string[]; done: () => void }> => {
      const list = latest.current[session] ?? [];
      set(session, (c) => c.map((x) => ({ ...x, saving: true })));
      try {
        const sent: { id: string; path: string; thumb: string }[] = [];
        for (const chip of list) {
          if (removed.current.has(chip.id)) continue;
          const abort = new AbortController();
          aborts.current.set(chip.id, abort);
          let path: string;
          try {
            path = await upload(core, session, chip.blob, abort.signal);
          } catch (e) {
            if (abort.signal.aborted) continue;
            throw e;
          } finally {
            aborts.current.delete(chip.id);
          }
          sent.push({ id: chip.id, path, thumb: chip.thumb });
        }
        // Checked again right before the send: a chip removed after its upload finished is not sent either.
        const kept = sent.filter((x) => !removed.current.has(x.id));
        if (list.length && !kept.length) throw new Error('cancelled');
        for (const x of kept) sentThumbs.set(x.path, x.thumb);
        setError((all) => ({ ...all, [session]: '' }));
        const ids = new Set(list.map((c) => c.id));
        return {
          paths: kept.map((x) => x.path),
          done: () => {
            set(session, (c) => c.filter((x) => !ids.has(x.id)));
            blobStore.remove([...ids].map((id) => chipKey(session, id))).catch(unsaved);
          },
        };
      } catch (e) {
        const msg = rawError(e);
        setError((all) => ({ ...all, [session]: msg === 'cancelled' ? docT()('own.img.removed') : docT()('own.img.notSaved', { reason: lineError(docT(), e) }) }));
        throw e;
      } finally {
        set(session, (c) => c.map((x) => ({ ...x, saving: false })));
      }
    },
    [core],
  );

  return { of: (session: string) => chips[session] ?? [], error: (session: string) => error[session] ?? '', add, remove, save };
}
export type Images = ReturnType<typeof useImages>;

/** Image files carried by a paste or drop event; text and other kinds are left to the textarea. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return [...data.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
}

/** The composer box's paste and drop handlers: only the event's own files; a text paste reaches the textarea. */
export function composerDrop(images: Images, session: string | undefined) {
  const take = (e: { preventDefault: () => void }, data: DataTransfer | null) => {
    const files = filesOf(data);
    if (!files.length || !session) return;
    e.preventDefault();
    void images.add(session, files);
  };
  return {
    'data-chip-session': session, // how nativeDrop.ts, which only has the box, says something under its chips
    onPaste: (e: ClipboardEvent) => take(e, e.clipboardData),
    onDragOver: (e: DragEvent) => e.dataTransfer.types.includes('Files') && session && e.preventDefault(),
    onDrop: (e: DragEvent) => {
      if (!inApp()) return take(e, e.dataTransfer);
      // Ticket 371: in the app the native event (nativeDrop.ts) owns every OS file, images too, so one drop is never both a chip and a path.
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
  };
}
