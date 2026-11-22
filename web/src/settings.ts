// Window settings (spec Window (v1a) Settings tab). Stored per window in localStorage; a broken store
// falls back to defaults field by field and is never partially trusted.
import { serveFonts } from './settings/appearance/serve';
import { cleanHintKeys, DEFAULT_HINT_KEYS, type HintKeys } from './hintLabels';
import type { Bindings } from './keys';
import { DROPPED } from './themes/dropped';
import { validColors } from './themes/ghostty';
import { isSource } from './themes/import';
import { DARK_PICK, LIGHT_PICK, type ThemePick } from './themes/nunchiro';
import { cleanBars, defaultBars, type Bars } from './layout/bars';
import { cleanPresets, type Preset } from './layout/presets';
import { LANGUAGES, type Language } from './i18n';
import { PAGES } from './features/registry';
import { MOVED_PAGES } from './features/builtin';
import type { Level } from './queue/notify';

export type Density = 'compact' | 'comfortable' | 'spacious';
/** Waiting alerts: the answer strip where the user placed it (default), off (row opens a card), signal only (needs 31). */
export type Strip = 'on' | 'off' | 'signal';
/** System follows the OS between the light and dark picks (Ghostty `theme = light:X,dark:Y`); fixed uses one theme. */
export type ThemeMode = 'system' | 'fixed';
/** v1a-35: what an OSC 52 clipboard write from terminal output does. */
export type Osc52 = 'ask' | 'allow' | 'deny';
/** LAYOUT D5b (A30): the title bar is always shown, hidden until the pointer reaches the window top, or hidden. */
export type TitleBar = 'always' | 'auto' | 'hidden';
/** SPLITNEW: what a new split opens (a split made by a key; a dragged widget opens itself). */
export type NewSplit = 'chat' | 'terminal' | 'chooser';
/** v1a-38: /System/Library/Sounds on macOS; the app's `play_sound` takes only these names (main.rs SOUNDS). */
export const SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'] as const;
export type SoundChoice = (typeof SOUNDS)[number] | 'off';
/** A page id: a built-in one, or one a feature registered (features/registry.ts). */
export type SettingsPage = string;

export interface Settings {
  /** needs 150: the store's version; each approved default change bumps it and migrates the stored value once (`parse`). */
  version: number;
  density: Density;
  /** STYLE 2026-10-28: set when the user picks a density, so the start-up save of the default is not mistaken for a choice. */
  densityPicked: boolean;
  /** ticket 162 (needs 146): a typed tree row height in px, or null for the density's own (the segment reads Custom). */
  rowHeight: number | null;
  tabFont: number;
  /** v25-chat-calm (needs 144): the chat body and composer max width, percent of the 700px default. */
  chatWidth: number;
  strip: Strip;
  themeMode: ThemeMode;
  themeLight: ThemePick;
  themeDark: ThemePick;
  themeFixed: ThemePick;
  /** Themes pasted in on the Theme page (needs 55 owner correction: kept in the app, never read from another app). */
  themesImported: ThemePick[];
  /** V1A-47, V1A-62: online themes in the Theme gallery (fetched only while that page is open); off sends nothing. */
  themeBrowse: boolean;
  /** V1A-62: built-in theme ids hidden from the gallery (Hide; "Show hidden" clears it). */
  themesHidden: string[];
  /** Ticket 1039: chat marks (headings, bold, code, paths, links, tool names) in the theme's accent colours, or Plain: the chat as it was before. */
  chatColours: 'theme' | 'plain';
  termFont: string;
  termFontSize: number;
  /** Last Settings page shown in this window. */
  settingsPage: SettingsPage;
  bindings: Bindings;
  /** V1A-57: ms after the prefix with no next key before the prefix help shows; 0 = never on its own (`?` still opens it). */
  prefixHelpDelay: number;
  /** V1A-48: hint kind keys, index keys and display layout (Settings > Keys > Hints). */
  hintKeys: HintKeys;
  /** First-run macOS Ctrl+Space check has been answered. */
  inputSourceChecked: boolean;
  /** Spawn order of sessions as first seen (AGENTS is never re-sorted). */
  order: string[];
  collapsed: string[];
  /** v1b-09: open folders in the Files tree, per session id (additive, absent = none). */
  filesExpanded: Record<string, string[]>;
  /** v1a-35: a terminal selection is copied on mouse-up. */
  copyOnSelect: boolean;
  osc52: Osc52;
  /** v1a-38: macOS system sound per event (needs 56), or off; volume 0 to 1. */
  soundDone: SoundChoice;
  soundWaiting: SoundChoice;
  soundVolume: number;
  /** B4 (ticket 217): the notify level of a session with none of its own; the header chip still sets one per session. */
  notifyDefault: Level;
  /** Ticket 316 (final.html new.notifyFocused): skip sound and notification for the session in front of the user. */
  notifyFocused: boolean;
  /** LAYOUT D5b: the icon bars' arrangement (membership, order, open widget per side), kept per window beside layout.toml's zones. */
  bars: Bars;
  /** The preset the arrangement was loaded from, and the user's saved ones (a saved one may override a built-in). */
  preset: string;
  presets: Preset[];
  titleBar: TitleBar;
  /** The one-time hint after the title bar was first hidden has been shown. */
  titleHint: boolean;
  newSplit: NewSplit;
  /** V2-14a: the window's text language; System follows the browser's language (`resolveLanguage`). */
  language: Language;
  /** Ticket 250: absorb features' window values by key (settings/useFeatureSetting.ts cleans each one when read). */
  features: Record<string, unknown>;
}

/** needs 150: 2 = copy on select on (ticket 162); 3 = the A+B+C sizes (ticket 1041, owner 15.1 item 7). A store without `version` is 1. */
export const STORE_VERSION = 3;

export const DEFAULTS: Settings = {
  version: STORE_VERSION,
  density: 'comfortable',
  densityPicked: false,
  rowHeight: null,
  tabFont: 13, // ticket 1041 (owner 15.1 item 7): the A+B+C body size, docs/design/polish-1121/index.html .tab (was 11.5)
  chatWidth: 100,
  strip: 'on',
  themeMode: 'system',
  themeLight: LIGHT_PICK,
  themeDark: DARK_PICK,
  themeFixed: LIGHT_PICK,
  themesImported: [],
  themeBrowse: true,
  themesHidden: [],
  chatColours: 'theme',
  termFont: '"SF Mono", "Symbols Nerd Font Mono", Menlo, "D2Coding", monospace', // needs 152: the bundled symbols face on by default
  termFontSize: 12,
  settingsPage: 'general',
  bindings: {},
  prefixHelpDelay: 300,
  hintKeys: DEFAULT_HINT_KEYS,
  inputSourceChecked: false,
  order: [],
  collapsed: [],
  filesExpanded: {}, // v1b-09
  copyOnSelect: true, // ticket 162: terminal-native peers (Ghostty, iTerm2) copy on select (docs/research/settings-polish.md)
  osc52: 'ask',
  soundDone: 'Glass',
  soundWaiting: 'Ping',
  soundVolume: 1,
  notifyDefault: 'all',
  notifyFocused: true,
  bars: defaultBars(),
  preset: 'Default',
  presets: [],
  titleBar: 'always',
  titleHint: false,
  newSplit: 'chooser',
  language: 'system',
  features: {},
};

/**
 * Every setting by page (V1A-57; needs 69), from the feature registry: a field marked `data-setting="<key>"` on its page is
 * found by the search on that page even before it is listed (V1A-73); settings-search.spec.ts fails until it is, so the
 * palette and the other pages' search reach it too.
 */
export { FIELDS, PAGES } from './features/registry';

/** A field's label in the shown language (catalogue key `field.<key>`; a key the page marks but FIELDS lacks is named from its DOM). */
// `never`: any `makeT` result fits, including one over an injected table in a test.
type Tr = (key: never, args?: Record<string, string | number>) => string;
export const fieldLabel = (t: Tr, key: string) => t(`field.${key}` as never);
/** Ticket 991 C14: fields whose row has its own, shorter title; a Settings search result shows that title (the field's
 *  longer name stays a search word). */
export const ROW_TITLE: Record<string, string> = {
  density: 'settings.density.rowHeight',
  themeMode: 'settings.theme.mode',
  themes: 'settings.theme.pick',
  language: 'settings.row.language',
  lifetime: 'settings.row.close',
  osc52: 'settings.clip.osc52',
  newSplit: 'settings.layout.newSplit',
  strip: 'settingsReset.strip',
  soundDone: 'settings.alerts.done',
  soundWaiting: 'settings.alerts.waiting',
  prefixHelpDelay: 'settings.row.helpDelay',
  hintKeys: 'settings.keys.alphabet',
  maskHistory: 'settings.row.mask',
};
/** A search result's name: the row's own title. */
export const resultLabel = (t: Tr, key: string) => (ROW_TITLE[key] ? t(ROW_TITLE[key] as never) : fieldLabel(t, key));
/** The palette entry for a field: `Settings: <label>` from the catalogue. */
export const settingsCommandTitle = (t: Tr, key: string) => t('palette.settings' as never, { label: fieldLabel(t, key) });
// Ticket 516: Hangul is matched as typed. An IME shows a half-typed word as its last keystrokes ("글씨 크" then "글씨 극" on
// the way to "글씨 크게"), so both sides are spelled out as the keys a 2-set keyboard presses: a syllable as its letters, a
// double vowel or final as its two. "극" is then ㅋㅡㄱ, the start of "크게" (ㅋㅡㄱㅔ).
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅗㅏ', 'ㅗㅐ', 'ㅗㅣ', 'ㅛ', 'ㅜ', 'ㅜㅓ', 'ㅜㅔ', 'ㅜㅣ', 'ㅠ', 'ㅡ', 'ㅡㅣ', 'ㅣ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ', 'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const PAIRS: Record<string, string> = { ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ', ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ', ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ' };
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
/** A string as the keys typed for it (Hangul spelled out by letter; anything else as it is). */
export const keystrokes = (s: string) =>
  [...s.normalize('NFC')]
    .map((ch) => {
      const i = ch.charCodeAt(0) - 0xac00;
      if (i >= 0 && i < 11172) return CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + JONG[i % 28];
      return PAIRS[ch] ?? ch;
    })
    .join('');
/** Settings search: whether `q` (already trimmed) is in `text`, case-insensitively; a query with Hangul matches by keystroke. */
export const searchHas = (q: string, text: string) => {
  const a = text.toLowerCase();
  const b = q.toLowerCase();
  return a.includes(b) || (HANGUL.test(b) && keystrokes(a).includes(keystrokes(b)));
};
/**
 * Settings search rank (ticket 427; ticket 516 the words): 0 when the query is in the setting's own label, 1 in its search
 * words (`searchWords.<key>`, what a user would type for it), 2 in its page's title, 3 only in the page's keywords
 * (SettingsView's ALIAS); -1 for no match. Each part is matched alone, so a query that only spans two of them finds nothing.
 */
export const fieldRank = (q: string, title: string, alias: string, label: string, words = '') =>
  searchHas(q, label) ? 0 : words && searchHas(q, words) ? 1 : searchHas(q, title) ? 2 : searchHas(q, alias) ? 3 : -1;
/** Settings search: the query against the shown page title, the English alias and the shown label. */
export const fieldMatches = (q: string, title: string, alias: string, label: string) => fieldRank(q, title, alias, label) >= 0;

/** Ticket 427 (was ownFirst, ticket 391 follow-up E): the matching fields by rank, label hits first, then search-word hits (ticket
 *  516), then page-title hits, then keyword hits, each tier in its listed order, so Enter opens the field the words name. */
export const rankedMatches = <F>(fields: F[], rank: (f: F) => number) =>
  fields
    .map((f) => ({ f, r: rank(f) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.f);

/** The palette's `settings.<page>.<key>` commands (kept off the Keys page and the Settings command list). */
export const fieldCommand = (id: string) => /^settings\.[\w-]+\./.test(id);

/** Row heights in px (needs 39: compact = R7-2, comfortable = R7-1; spacious from the R8 settings draft). */
export const DENSITY: Record<Density, { row: number; arow: number; tabh: number }> = {
  compact: { row: 22, arow: 20, tabh: 26 },
  comfortable: { row: 32, arow: 24, tabh: 36 }, // ticket 1041 (owner 15.1 item 7): A+B+C rows 32 and tab strip 36 on the 8 px grid (was the ko/ 30 / 32)
  spacious: { row: 34, arow: 28, tabh: 36 }, // stays a step above comfortable
};

/** ticket 162: a typed row height, whole px; the agents row and the tab strip follow it as the presets do. */
export const ROW_MIN = 18;
export const ROW_MAX = 44;
export const isRowHeight = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= ROW_MIN && (v as number) <= ROW_MAX;
export const heights = (s: Pick<Settings, 'density' | 'rowHeight'>) =>
  s.rowHeight === null ? DENSITY[s.density] : { row: s.rowHeight, arow: Math.round(s.rowHeight * 0.8), tabh: s.rowHeight + 2 };

/** The prefix help delay: whole ms from 0 (off) to HELP_DELAY_MAX, for the store and the Keys page field alike. */
export const HELP_DELAY_MAX = 5000;
export const isHelpDelay = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= HELP_DELAY_MAX;

export const KEY = 'nunchiro.settings.v1';
const isSound = (v: unknown) => v === 'off' || (SOUNDS as readonly unknown[]).includes(v);
const GOOD_KEY = `${KEY}.lastgood`; // the last keymap that passed validBindings, kept beside the store
const validBindings = (v: unknown): v is Bindings => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(strings);
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
/** Rebuilds a stored pick from checked fields only; a Nunchiro id always means the bundled colours. */
const cleanPick = (v: unknown): ThemePick | null => {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id.length > 300 || typeof p.name !== 'string' || p.name.length > 200) return null;
  const nunchiro = [LIGHT_PICK, DARK_PICK].find((n) => n.id === p.id);
  if (nunchiro) return nunchiro;
  const colors = validColors(p.colors);
  if (!colors || (p.source !== undefined && !isSource(p.source))) return null;
  if (p.licence !== undefined && (typeof p.licence !== 'string' || p.licence.length > 100)) return null;
  const c = p.copyright;
  if (c !== undefined && !(Array.isArray(c) && c.length <= 20 && c.every((l) => typeof l === 'string' && l.length <= 300))) return null;
  return {
    id: p.id,
    name: p.name,
    colors,
    ...(p.source !== undefined ? { source: p.source as string } : {}),
    ...(p.licence !== undefined ? { licence: p.licence as string } : {}),
    ...(c !== undefined ? { copyright: [...(c as string[])] } : {}),
  };
};
/** V1A-62: a pick of a theme dropped from the bundle becomes the same colours as an imported theme, never another theme. */
const undrop = (p: ThemePick): ThemePick => {
  const name = p.id.startsWith('catalog:') ? p.id.slice(8) : '';
  const d = Object.hasOwn(DROPPED, name) ? DROPPED[name] : null;
  return d ? { id: `imported:${name}`, name, colors: p.colors, licence: d.licence, source: d.source, copyright: [...d.copyright] } : p;
};
const hidden = (v: unknown) => strings(v) && (v as string[]).length <= 200 && (v as string[]).every((s) => s.length <= 300);
/** Imported themes kept at most; a longer stored list is refused whole, so nothing may append past it. */
export const IMPORTS_CAP = 200;
const cleanImports = (v: unknown): ThemePick[] | null => {
  if (!Array.isArray(v) || v.length > IMPORTS_CAP) return null;
  const list = v.map(cleanPick);
  return list.every((p) => p) && new Set(list.map((p) => p!.id)).size === list.length ? (list as ThemePick[]) : null;
};
/** A font list for xterm: comma-separated bare names or closed "..." / '...' names, up to 200 characters. */
const FAMILY = String.raw` *(?:[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*|"[\p{L}\p{N} ._-]+"|'[\p{L}\p{N} ._-]+') *`;
/** The default termFont before needs 152 (no symbols face): a stored copy of it reads as today's default. */
const OLD_TERM_FONT = '"SF Mono", Menlo, "D2Coding", monospace';
export const FONT = new RegExp(`^(?=.{1,200}$)${FAMILY}(?:,${FAMILY})*$`, 'u');

/**
 * Parses the store; `clean` is false when anything was rejected and defaults replaced it. `undo` holds the stored values a
 * version migration replaced (needs 150), for the one Undo toast; null when nothing moved.
 */
export function parse(raw: string | null, lastGood?: string | null): { settings: Settings; clean: boolean; undo: Partial<Settings> | null } {
  let v: Record<string, unknown> = {};
  let clean = true;
  try {
    const parsed = JSON.parse(raw ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
    else clean = false;
  } catch {
    clean = false;
  }
  const pick = <T,>(ok: boolean, value: unknown, fallback: T): T => {
    if (!ok && value !== undefined) clean = false;
    return ok ? (value as T) : fallback;
  };
  // Like pick, but keeps the rebuilt value, not the stored one.
  const rebuilt = <T,>(raw: unknown, check: (v: unknown) => T | null, fallback: T): T => {
    const c = raw === undefined ? null : check(raw);
    return pick(c !== null, c ?? raw, fallback);
  };
  const bindings = v.bindings;
  const bindingsOk = validBindings(bindings);
  // needs 170 (3): a keymap that fails the check keeps the last good one (same `bindingsOk` test), else {} as before.
  const goodBindings = (): Bindings => {
    try {
      const g: unknown = JSON.parse((lastGood === undefined ? localStorage.getItem(GOOD_KEY) : lastGood) ?? 'null');
      return validBindings(g) ? g : DEFAULTS.bindings;
    } catch {
      return DEFAULTS.bindings;
    }
  };
  const settings: Settings = {
    version: STORE_VERSION,
    density: pick(['compact', 'comfortable', 'spacious'].includes(v.density as string), v.density, DEFAULTS.density),
    densityPicked: pick(typeof v.densityPicked === 'boolean', v.densityPicked, false),
    rowHeight: pick(v.rowHeight === null || isRowHeight(v.rowHeight), v.rowHeight, null),
    tabFont: pick(typeof v.tabFont === 'number' && v.tabFont >= 10 && v.tabFont <= 15, v.tabFont, DEFAULTS.tabFont),
    chatWidth: pick(typeof v.chatWidth === 'number' && v.chatWidth >= 60 && v.chatWidth <= 160, v.chatWidth, DEFAULTS.chatWidth),
    strip: pick(['on', 'off', 'signal'].includes(v.strip as string), v.strip, DEFAULTS.strip),
    // Before V1A-34 the theme was `system`, `light` or `dark`: light and dark mean the Nunchiro theme, fixed.
    themeMode:
      v.themeMode === undefined && v.theme !== undefined
        ? pick(['system', 'light', 'dark'].includes(v.theme as string), v.theme === 'system' ? 'system' : 'fixed', DEFAULTS.themeMode)
        : pick(['system', 'fixed'].includes(v.themeMode as string), v.themeMode, DEFAULTS.themeMode),
    themeLight: rebuilt(v.themeLight, cleanPick, DEFAULTS.themeLight),
    themeDark: rebuilt(v.themeDark, cleanPick, DEFAULTS.themeDark),
    themeFixed: v.themeFixed === undefined && v.theme === 'dark' ? DARK_PICK : rebuilt(v.themeFixed, cleanPick, DEFAULTS.themeFixed),
    themesImported: rebuilt(v.themesImported, cleanImports, []),
    themeBrowse: pick(typeof v.themeBrowse === 'boolean', v.themeBrowse, DEFAULTS.themeBrowse),
    themesHidden: pick(hidden(v.themesHidden), v.themesHidden, []),
    chatColours: pick(['theme', 'plain'].includes(v.chatColours as string), v.chatColours, DEFAULTS.chatColours),
    // needs 150/152: the old default list (no symbols face) reads as the new default, so a stored default never holds it back.
    termFont: pick(typeof v.termFont === 'string' && FONT.test(v.termFont) && v.termFont !== OLD_TERM_FONT, v.termFont, DEFAULTS.termFont),
    termFontSize: pick(typeof v.termFontSize === 'number' && v.termFontSize >= 10 && v.termFontSize <= 20, v.termFontSize, DEFAULTS.termFontSize),
    // An old page id (folded into another page) opens its new home; ticket 250 made the others pages again.
    settingsPage: Object.hasOwn(MOVED_PAGES, v.settingsPage as string) ? MOVED_PAGES[v.settingsPage as string]! : pick(PAGES.includes(v.settingsPage as SettingsPage), v.settingsPage, DEFAULTS.settingsPage),
    bindings: pick(bindingsOk, bindings, DEFAULTS.bindings),
    prefixHelpDelay: pick(isHelpDelay(v.prefixHelpDelay), v.prefixHelpDelay, DEFAULTS.prefixHelpDelay),
    hintKeys: rebuilt(v.hintKeys, cleanHintKeys, DEFAULTS.hintKeys),
    inputSourceChecked: pick(typeof v.inputSourceChecked === 'boolean', v.inputSourceChecked, false),
    order: pick(strings(v.order), v.order, []),
    collapsed: pick(strings(v.collapsed), v.collapsed, []),
    // v1b-09
    filesExpanded: pick(
      !!v.filesExpanded && typeof v.filesExpanded === 'object' && !Array.isArray(v.filesExpanded) && Object.values(v.filesExpanded).every(strings),
      v.filesExpanded,
      {},
    ),
    // v1a-35
    copyOnSelect: pick(typeof v.copyOnSelect === 'boolean', v.copyOnSelect, DEFAULTS.copyOnSelect),
    osc52: pick(['ask', 'allow', 'deny'].includes(v.osc52 as string), v.osc52, DEFAULTS.osc52),
    // v1a-38
    soundDone: pick(isSound(v.soundDone), v.soundDone, DEFAULTS.soundDone),
    soundWaiting: pick(isSound(v.soundWaiting), v.soundWaiting, DEFAULTS.soundWaiting),
    soundVolume: pick(typeof v.soundVolume === 'number' && v.soundVolume >= 0 && v.soundVolume <= 1, v.soundVolume, DEFAULTS.soundVolume),
    notifyDefault: pick(['all', 'waiting', 'muted'].includes(v.notifyDefault as string), v.notifyDefault, DEFAULTS.notifyDefault),
    notifyFocused: pick(typeof v.notifyFocused === 'boolean', v.notifyFocused, DEFAULTS.notifyFocused),
    // LAYOUT D5b
    bars: rebuilt(v.bars, cleanBars, defaultBars()),
    preset: pick(typeof v.preset === 'string' && v.preset.length <= 60, v.preset, DEFAULTS.preset),
    presets: rebuilt(v.presets, (x) => cleanPresets(x, cleanBars), []),
    titleBar: pick(['always', 'auto', 'hidden'].includes(v.titleBar as string), v.titleBar, DEFAULTS.titleBar),
    titleHint: pick(typeof v.titleHint === 'boolean', v.titleHint, false),
    newSplit: pick(['chat', 'terminal', 'chooser'].includes(v.newSplit as string), v.newSplit, DEFAULTS.newSplit),
    language: pick(LANGUAGES.some((l) => l.id === v.language), v.language, DEFAULTS.language),
    // Ticket 250: the map must be a plain object; each value is checked by its feature's `clean` when read.
    features: pick(!!v.features && typeof v.features === 'object' && !Array.isArray(v.features), v.features, {}),
  };
  // STYLE 2026-10-28, once for a store from before the flag: compact was the default and the window saves every field
  // at start, so a stored compact is that old default and moves to comfortable; a stored comfortable or spacious was
  // picked by hand.
  if (v.densityPicked === undefined && v.density !== undefined && settings.density === v.density) {
    if (settings.density === 'compact') settings.density = DEFAULTS.density;
    else settings.densityPicked = true;
  }
  // V1A-62: dropped catalog picks join Imported once, in slot order (migration, not a rejection: the store stays clean).
  for (const k of ['themeLight', 'themeDark', 'themeFixed'] as const) {
    const p = undrop(settings[k]);
    if (p === settings[k]) continue;
    settings[k] = p;
    // A full list keeps the slot as it is (same colours) without growing past the cap.
    if (!settings.themesImported.some((x) => x.id === p.id) && settings.themesImported.length < IMPORTS_CAP) settings.themesImported = [...settings.themesImported, p];
  }
  // needs 150: an approved default change moves the stored value once, per store version. Only a stored value is moved
  // (a fresh store already has the new default) and only an older store (a newer one was migrated or picked by hand).
  const from = Number.isInteger(v.version) ? (v.version as number) : 1;
  // A newer build's store keeps its number, so going back and forth never re-runs that build's migrations.
  settings.version = Math.max(from, STORE_VERSION);
  const undo: Partial<Settings> = {};
  if (from < 2 && settings.copyOnSelect === false) {
    undo.copyOnSelect = false;
    settings.copyOnSelect = true;
  }
  // Ticket 1041 (owner 15.1 item 7): the new sizes reach only a user who never changed them. A row height picked by hand
  // as the old comfortable keeps its 30 / 24 / 32 px as a typed 30 (heights() gives the same three); a stored tab font
  // at the old default 11.5 is that default (the window saves every field at start) and moves to the new one. No toast.
  if (from < 3) {
    if (settings.densityPicked && settings.density === 'comfortable' && settings.rowHeight === null) settings.rowHeight = 30;
    if (settings.tabFont === 11.5) settings.tabFont = DEFAULTS.tabFont;
  }
  // A keymap that is missing or fails the check (also a store that did not parse at all) keeps the last good one.
  if (!bindingsOk) settings.bindings = goodBindings();
  return { settings, clean, undo: Object.keys(undo).length ? undo : null };
}

let migrated: Partial<Settings> | null = null;
/** The values the start-up migration replaced (once: a second call returns null), for the Undo toast. */
export const takeMigration = () => {
  const m = migrated;
  migrated = null;
  return m;
};

export function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const { settings, clean, undo } = parse(raw);
    migrated = undo;
    notifyNow = settings.notifyDefault;
    focusedNow = settings.notifyFocused;
    // The keymap is a stand-in when the store holds none that passes the check: the save that follows must not write it
    // over `.lastgood`.
    let stored: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(raw ?? '{}');
      if (v && typeof v === 'object' && !Array.isArray(v)) stored = v as Record<string, unknown>;
    } catch {
      // Unreadable: nothing stored to keep.
    }
    standIn = validBindings(stored.bindings) ? null : settings.bindings;
    // Q9 zh-hant-J13-3: a newer build's fields this build does not know are written back as they were.
    extra = Object.fromEntries(Object.entries(stored).filter(([k]) => !Object.hasOwn(settings, k)));
    // Keep what was rejected, byte for byte, before the defaults are saved over it.
    // Q9 zh-hant-J13-1: a backup that cannot be written (quota) loses only the backup, never the fields that parsed.
    if (!clean && raw !== null)
      try {
        localStorage.setItem(`${KEY}.bak`, raw);
      } catch {
        // Storage full: the rejected original is not kept.
      }
    return settings;
  } catch {
    standIn = DEFAULTS.bindings;
    return { ...DEFAULTS };
  }
}

/** The keymap load() put in place of a missing or broken one: not the user's, so `save` keeps it out of `.lastgood`. */
let standIn: Bindings | null = null;
/** The stored fields load() did not know (a newer build's), kept by every `save`. */
let extra: Record<string, unknown> = {};

/**
 * B4: the stored notification default, live for queue/notify.tsx (`useSyncExternalStore`): the window's settings live in
 * App's state, which hands them to no hook there, so `save` tells the hook when the default moved.
 */
let notifyNow: Level = DEFAULTS.notifyDefault;
const NOTIFY_EVENT = 'nunchiro:notify.default';
export const notifyDefault = () => notifyNow;
// Ticket 316: read when an alert is about to fire, so nothing has to subscribe.
let focusedNow = DEFAULTS.notifyFocused;
export const notifyFocused = () => focusedNow;
export const onNotifyDefault = (changed: () => void) => {
  window.addEventListener(NOTIFY_EVENT, changed);
  return () => window.removeEventListener(NOTIFY_EVENT, changed);
};

export function save(s: Settings) {
  focusedNow = s.notifyFocused;
  serveFonts(s.termFont); // V1A-67: save runs at start and on every change, so the picked face follows the setting
  if (s.notifyDefault !== notifyNow) {
    notifyNow = s.notifyDefault;
    window.dispatchEvent(new Event(NOTIFY_EVENT));
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...extra, ...s }));
    if (validBindings(s.bindings) && s.bindings !== standIn) localStorage.setItem(GOOD_KEY, JSON.stringify(s.bindings));
  } catch {
    // Storage blocked: settings last for this window only.
  }
}
