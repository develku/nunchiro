// Terminal font choices (V1A-64; needs 71): curated coding fonts found installed in this webview or held by the app, the
// termFont list an entry writes, and the Symbols Nerd Font fallback. Nunchiro bundles that one symbols font (needs 152,
// amends needs 71) and fetches none (needs 2); V1A-67: the app hands over the user's own font files, which the app's
// WKWebView does not see.
import { DEFAULTS, FONT } from '../../settings';
import { inApp, invoke, names, SYMBOLS, unquote } from './serve';

export { SYMBOLS };

/**
 * Each family followed by its Nerd Font Mono build (the patched fonts' own family names, which differ for some).
 * shortcut: only "JetBrainsMono Nerd Font Mono" was checked against a real font file (fc-scan); the other Nerd names
 * are the Nerd Fonts v3 family names from memory, check each against an installed file when one is at hand.
 */
export const CURATED = [
  'SF Mono',
  'Menlo',
  'MesloLGS Nerd Font Mono',
  'Monaco',
  'JetBrains Mono',
  'JetBrainsMono Nerd Font Mono',
  'Fira Code',
  'FiraCode Nerd Font Mono',
  'Cascadia Code',
  'CaskaydiaCove Nerd Font Mono',
  'Hack',
  'Hack Nerd Font Mono',
  'Iosevka',
  'Iosevka Nerd Font Mono',
  'Source Code Pro',
  'SauceCodePro Nerd Font Mono',
  'IBM Plex Mono',
  'BlexMono Nerd Font Mono',
  'D2Coding',
  'D2CodingLigature Nerd Font Mono',
];
/** The default list's faces after its first, behind every entry, so Hangul (D2Coding) renders as the default does. */
const FALLBACK = names(DEFAULTS.termFont)
  .slice(1, -1)
  .filter((f) => f !== SYMBOLS);

/**
 * Installed when the width of `"<name>", serif` differs from serif and `"<name>", sans-serif` from sans-serif: a
 * missing font measures as its fallback. `document.fonts.check` answers true for any name in WebKit and Chromium.
 */
export function detect(candidates: string[], measure: (family: string) => number): string[] {
  const serif = measure('serif');
  const sans = measure('sans-serif');
  return candidates.filter((n) => measure(`"${n}", serif`) !== serif && measure(`"${n}", sans-serif`) !== sans);
}

/** The curated fonts found installed, plus the bundled symbols face (always there); tests set window.__NUNCHIRO_FONTS__. */
export function installedFonts(): string[] {
  const mocked = (window as { __NUNCHIRO_FONTS__?: string[] }).__NUNCHIRO_FONTS__;
  if (mocked) return [...CURATED.filter((n) => mocked.includes(n)), SYMBOLS];
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return [SYMBOLS];
  const found = detect(CURATED, (family) => {
    ctx.font = `72px ${family}`;
    return ctx.measureText('mmmmmmmmmmlli10OoWw@#{}').width;
  });
  return [...found, SYMBOLS];
}

/** V1A-67: the curated fonts (and the symbols face) the app can hand over from ~/Library/Fonts or /Library/Fonts. */
export async function appFonts(): Promise<string[]> {
  if (!inApp()) return [];
  const all = [...CURATED, SYMBOLS];
  const got = await invoke<unknown>('font_families', { names: all }).catch(() => []);
  return Array.isArray(got) ? all.filter((n) => got.includes(n)) : [];
}

export type Family = { name: string; mono: boolean };

/** Every installed family (fonts.rs `font_list`); empty in a browser or on error, where the curated detection stands. */
export async function allFonts(): Promise<Family[]> {
  const mocked = (window as { __NUNCHIRO_FONTS_ALL__?: Family[] }).__NUNCHIRO_FONTS_ALL__;
  if (mocked) return mocked;
  if (!inApp()) return [];
  const got = await invoke<unknown>('font_list', {}).catch(() => []);
  // Rust's alphanumeric takes some combining marks FONT refuses, and a name FONT refuses could never be stored.
  return Array.isArray(got) ? (got as Family[]).filter((f) => FONT.test(`"${f.name}"`)) : [];
}

export const hasSymbols = (list: string) => names(list).includes(SYMBOLS);

/** Puts the symbols face right after the main face (once), or takes every copy out; other entries keep their text. */
export function withSymbols(list: string, on: boolean): string {
  const parts = list
    .split(',')
    .map((p) => p.trim())
    .filter((p) => unquote(p) !== SYMBOLS);
  if (on) parts.splice(1, 0, `"${SYMBOLS}"`);
  return parts.join(', ');
}

/** The termFont an entry writes: the family first, the default's fallbacks, monospace last. */
export function termFontFor(family: string, symbols: boolean): string {
  const list = [family, ...FALLBACK.filter((f) => f !== family)].map((f) => `"${f}"`);
  return withSymbols([...list, 'monospace'].join(', '), symbols);
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i]);

/**
 * The installed entry a stored list was written by (the symbols face aside), or null for a Custom… list. The default
 * list reads as its first installed face: WebKit does not show SF Mono by name, so the default renders as Menlo there.
 */
export function entryOf(list: string, installed: string[]): string | null {
  const got = names(withSymbols(list, false));
  if (same(got, names(withSymbols(DEFAULTS.termFont, false)))) return got.find((n) => installed.includes(n)) ?? null;
  const family = got[0];
  if (!installed.includes(family)) return null;
  const want = names(termFontFor(family, false));
  return same(got, want) ? family : null;
}
