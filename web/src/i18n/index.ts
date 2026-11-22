// UI language (V2-14a; needs 93): window text only, never agent output or terminal content. A bundled catalogue:
// English holds every string; another language may hold only some, and a missing key shows English (per string).
import { createContext } from 'react';

export type Language = 'system' | 'en' | 'ko' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'es' | 'fr' | 'pt';
export type Lang = Exclude<Language, 'system'>;

/** The Language page's list, in order; each name in its own script (System is named by the catalogue). */
export const LANGUAGES: { id: Language; name: string | null }[] = [
  { id: 'system', name: null },
  { id: 'en', name: 'English' },
  { id: 'ko', name: '한국어' },
  { id: 'ja', name: '日本語' },
  { id: 'zh-Hans', name: '简体中文' },
  { id: 'zh-Hant', name: '繁體中文' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
  { id: 'pt', name: 'Português' },
];

/** Keys an area file adds: it augments this (`declare module '../index' { interface AreaKeys { 'x.y': true } }`) so `t('x.y')` type-checks. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AreaKeys {}
export type Key = keyof AreaKeys;
/** What a surface receives: `t(key, {name})` from `makeT`. */
export type T = (key: Key, args?: Record<string, string | number>) => string;

type Tables<K extends string> = { en: Record<K, string> } & Partial<Record<Lang, Partial<Record<K, string>>>>;

/** One area file (`areas/<area>.ts`): its English strings as `en`, any translations under their language id. */
export type AreaFile = Partial<Record<Lang, Record<string, string>>>;

/** Adds each area file's strings to the legacy tables; a key already present (legacy or another area file) throws, naming both files. */
export function mergeAreas(legacy: Record<Lang, Record<string, string>>, files: Record<string, AreaFile>): Record<Lang, Record<string, string>> {
  const out = Object.fromEntries(Object.entries(legacy).map(([l, t]) => [l, { ...t }])) as Record<Lang, Record<string, string>>;
  const owner: Record<string, string> = {};
  for (const [file, mod] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    for (const key of Object.keys(mod.en ?? {})) {
      if (key in out.en) throw new Error(`i18n key "${key}" defined twice: ${owner[key] ?? 'legacy catalogue'} and ${file}`);
      out.en[key] = mod.en![key]!;
      owner[key] = file;
    }
    for (const lang of Object.keys(out) as Lang[]) {
      // Area files export `zhHans` / `zhHant` (a hyphen is no identifier); read the table under either name.
      const table = mod[lang] ?? (mod as Record<string, Record<string, string>>)[lang.replace('-', '')];
      for (const [key, text] of Object.entries(lang === 'en' ? {} : table ?? {})) {
        if (!(key in (mod.en ?? {}))) throw new Error(`i18n key "${key}" in ${file} (${lang}) is not one of its English keys`);
        out[lang][key] = text;
      }
    }
  }
  return out;
}

// Area files are picked up by glob; the node test runner has no import.meta.glob, so it loads none (tests call mergeAreas).
let areaFiles: Record<string, AreaFile> = {};
try {
  areaFiles = import.meta.glob<AreaFile>('./areas/*.ts', { eager: true });
} catch {
  /* no Vite */
}
const MERGED = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, areaFiles);
export const EN = MERGED.en as Record<Key, string>;
export const TABLES = MERGED as unknown as Tables<Key>;

/** The language a choice shows: System reads the browser's language tag, an unknown tag gives English. */
export function resolveLanguage(choice: Language, tag: string): Lang {
  if (choice !== 'system') return choice;
  const [base, ...rest] = tag.toLowerCase().split('-');
  if (base === 'zh') return rest.includes('hant') || rest.some((r) => ['tw', 'hk', 'mo'].includes(r)) ? 'zh-Hant' : 'zh-Hans';
  return (['en', 'ko', 'ja', 'es', 'fr', 'pt'] as const).find((l) => l === base) ?? 'en';
}

/** `t(key, {name})` for a chosen language: its own string, else the English one, else the key (a missing key must not crash the window); `{name}` is replaced by args. */
export function makeT<K extends string = Key>(choice: Language, tag: string, tables: Tables<K> = TABLES as unknown as Tables<K>) {
  const lang = resolveLanguage(choice, tag);
  const plurals = new Intl.PluralRules(lang);
  return (key: K, args?: Record<string, string | number>): string => {
    let translatedKey = key;
    if (lang !== 'en' && typeof args?.n === 'number' && /\.(one|other)$/.test(key)) {
      const form = plurals.select(args.n) === 'one' ? 'one' : 'other';
      const candidate = key.replace(/\.(one|other)$/, `.${form}`) as K;
      // Fixed-count singular strings without {n} cannot express zero or fractions.
      if (tables[lang]?.[candidate]?.includes('{n}')) translatedKey = candidate;
    }
    let text: string = tables[lang]?.[translatedKey] ?? tables.en[key] ?? key;
    if (lang === 'ko' && args) text = particles(text, args);
    return text.replace(/\{(\w+)\}/g, (m, name: string) => (args && name in args ? String(args[name]) : m));
  };
}

/** A Korean particle's two forms: after a final consonant, after a vowel. */
const PARTICLE: Record<string, [string, string]> = { '이(가)': ['이', '가'], '을(를)': ['을', '를'], '은(는)': ['은', '는'], '와(과)': ['과', '와'], '(으)로': ['으로', '로'], '(이)라는': ['이라는', '라는'] };
/** How a word ends when read in Korean: a final consonant, ㄹ, a vowel, or unknown (null). */
function finalSound(word: string): 'consonant' | 'rieul' | 'vowel' | null {
  const w = word.replace(/[\u0001\u0002]/g, '').trim().toLowerCase(); // `around`'s marks
  const c = w.at(-1) ?? '';
  const code = c.charCodeAt(0) - 0xac00;
  if (code >= 0 && code < 11172) return code % 28 === 0 ? 'vowel' : code % 28 === 8 ? 'rieul' : 'consonant';
  if (/\d/.test(c)) return '178'.includes(c) ? 'rieul' : '036'.includes(c) ? 'consonant' : 'vowel'; // 일 칠 팔; 영 삼 육
  // shortcut: an English word's ending by spelling (glab 글랩, git 깃, Chrome 크롬, Claude 클로드, add 애드); a silent or odd ending reads wrong.
  if (/[a-z]/.test(c)) return c === 'l' ? 'rieul' : /(ng|[mn]e?|[aeiou](?:[bpt]|ck|k))$/.test(w) ? 'consonant' : 'vowel';
  return null;
}
/** Q5: "glab이(가)" reads as a template; the particle after an inserted word takes the form for its last sound. */
function particles(text: string, args: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}([”"’']?)(이\(가\)|을\(를\)|은\(는\)|와\(과\)|\(으\)로|\(이\)라는)/g, (m, name: string, quote: string, p: string) => {
    const sound = name in args ? finalSound(String(args[name])) : null;
    if (!sound) return m;
    const [after, vowel] = PARTICLE[p]!;
    return `{${name}}${quote}${sound === 'vowel' || (sound === 'rieul' && p === '(으)로') ? vowel : after}`;
  });
}

/** A sentence split around one element the caller puts in `name`'s place (a key chip, code): `word` is the text it reads
 *  as, so a Korean particle after it takes the right form (look 1117: "F을(를)" when the split passed a bare mark). */
export const around = (t: T, key: Key, name: string, word: string, args?: Record<string, string | number>): [string, string] => {
  const [a = '', b = ''] = t(key, { ...args, [name]: `\u0001${word}\u0002` }).split(/\u0001[^\u0002]*\u0002/);
  return [a, b];
};

/** The `<html lang>` for a choice: the resolved language only when its table has strings (else the window shows English). */
export function htmlLang<K extends string = Key>(choice: Language, tag: string, tables: Tables<K> = TABLES as unknown as Tables<K>): Lang {
  const lang = resolveLanguage(choice, tag);
  return Object.keys(tables[lang] ?? {}).length ? lang : 'en';
}

/** The chat list's `t` for rows nested too deep to take a prop (Rows.tsx, ClaudeLink.tsx); English until ChatView provides one. */
export const tEn: T = makeT('en', 'en');
export const Tr = createContext<T>(tEn);
