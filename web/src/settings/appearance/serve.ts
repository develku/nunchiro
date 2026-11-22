// V1A-67: the terminal font faces the app hands over (fonts.rs). Kept apart from fonts.ts, which imports settings.ts:
// settings.ts calls serveFonts, and this module must not import it back.

/** needs 152: the symbols face Nunchiro bundles (web/src/fonts, notice in THIRD_PARTY_NOTICES.md), the terminal's fallback. */
export const SYMBOLS = 'Symbols Nerd Font Mono';
export const unquote = (part: string) => part.trim().replace(/^(["'])(.*)\1$/, '$2');
export const names = (list: string) => list.split(',').map(unquote);
export const inApp = () => '__TAURI_INTERNALS__' in window;
export async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export type Face = { weight: number; italic: boolean; bytes: ArrayBuffer };
/** Splits the app's packed faces (fonts.rs `pack`): u16 weight, u8 italic, u32 length, bytes; a short tail is dropped. */
export function unpack(buf: ArrayBuffer): Face[] {
  const view = new DataView(buf);
  const faces: Face[] = [];
  for (let at = 0; at + 7 <= buf.byteLength; ) {
    const len = view.getUint32(at + 3);
    if (at + 7 + len > buf.byteLength) break;
    faces.push({ weight: view.getUint16(at), italic: view.getUint8(at + 2) === 1, bytes: buf.slice(at + 7, at + 7 + len) });
    at += 7 + len;
  }
  return faces;
}

/** Fired once a served family's faces have loaded, as a CustomEvent with `detail: { family }` (Terminal.tsx re-measures on it). */
export const FONTS_EVENT = 'nunchiro:fonts-loaded';
// CSS generic families name no font file.
const GENERIC = new Set(['monospace', 'serif', 'sans-serif', 'system-ui', 'ui-monospace', 'cursive', 'fantasy']);
const asked = new Set<string>();
/** The termFont list in use. Only its families re-measure terminals: the picker loads a face per visible row. */
let applied: string[] = [];
let pending: ReturnType<typeof setTimeout> | undefined;
let started = false;
/**
 * Loads each family a termFont list names (see `loadFamilies`). The first call after page load runs at once; typing a
 * Custom… list saves on every key, so after that only the list it settles on for a moment is asked for.
 */
export function serveFonts(list: string) {
  applied = names(list);
  if (names(list).includes(SYMBOLS)) loadSymbols();
  if (!inApp()) return;
  clearTimeout(pending);
  if (!started) {
    started = true;
    loadFamilies(names(list));
    return;
  }
  pending = setTimeout(() => loadFamilies(names(list)), 250);
}

/**
 * Loads each family once per page as FontFaces from the files the app hands over; the app answers nothing for a
 * system face or a name it does not hold, so those render as before.
 */
export function loadFamilies(families: string[]) {
  if (!inApp()) return;
  for (const family of families) {
    if (asked.has(family) || GENERIC.has(family) || family === SYMBOLS) continue;
    asked.add(family);
    invoke<ArrayBuffer>('font_faces', { family })
      .then(async (buf) => {
        const faces = unpack(buf).map((f) => new FontFace(family, f.bytes, { weight: String(f.weight), style: f.italic ? 'italic' : 'normal' }));
        for (const face of faces) document.fonts.add(face);
        const loaded = await Promise.all(faces.map((face) => face.load().then(() => true, () => (document.fonts.delete(face), false))));
        // xterm measures its cells only when fontFamily or fontSize is set, so live terminals re-measure now.
        if (loaded.some(Boolean) && applied.includes(family)) window.dispatchEvent(new CustomEvent(FONTS_EVENT, { detail: { family } }));
      })
      .catch(() => asked.delete(family));
  }
}

let symbols: Promise<void> | null = null;
/**
 * needs 152: loads the bundled symbols face once, then terminals re-measure (FONTS_EVENT), so a prompt's Nerd Font glyphs
 * never draw as boxes. Same origin as the page (CSP default-src 'self').
 */
export function loadSymbols() {
  // new URL(..., import.meta.url): Vite emits the file as an asset; the test runner (Node) only builds the URL.
  const file = new URL('../../fonts/SymbolsNerdFontMono-Regular.ttf', import.meta.url).href;
  symbols ??= new FontFace(SYMBOLS, `url(${file})`).load().then(
    (face) => {
      document.fonts.add(face);
      window.dispatchEvent(new CustomEvent(FONTS_EVENT, { detail: { family: SYMBOLS } }));
    },
    () => {
      symbols = null;
    },
  );
}
