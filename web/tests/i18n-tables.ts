// The window's catalogue for node-side specs. src/i18n merges the area files through import.meta.glob, which only Vite
// has, so under the Playwright runner its EN and TABLES are empty (ticket 167 moved every string into areas/*.ts).
// This loads the same files from disk and merges them with the product's own mergeAreas.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { htmlLang as htmlLangFor, makeT as makeTFor, mergeAreas, type AreaFile, type Key, type Language } from '../src/i18n';

const dir = path.resolve(import.meta.dirname, '../src/i18n/areas');
const files: Record<string, AreaFile> = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) files[`./areas/${f}`] = await import(path.join(dir, f));
const merged = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, files);

type Tables<K extends string> = NonNullable<Parameters<typeof makeTFor<K>>[2]>;
export const EN = merged.en as Record<Key, string>;
export const TABLES = merged as unknown as Tables<Key>;
export const makeT = <K extends string = Key>(choice: Language, tag: string, tables: Tables<K> = TABLES as unknown as Tables<K>) =>
  makeTFor<K>(choice, tag, tables);
/** Words of the English lines a language has no line for yet. owner 11-21 (ticket 1035): new strings are English only until
 * the one pass before the release, and a missing line shows English, so the English-left scans skip these words.
 * shortcut: a word also used by an old line is skipped too; ticket 1035 fills every table and makes this set empty. */
export const pendingWords = (lang: string): Set<string> => {
  const table = (TABLES as unknown as Record<string, Record<string, string>>)[lang] ?? {};
  return new Set(Object.entries(EN).filter(([k]) => !(k in table)).flatMap(([, v]) => (v.replace(/\{[^}]*\}/g, ' ').match(/\p{L}+/gu) ?? []).map((w) => w.toLowerCase())));
};
export const htmlLang = (choice: Language, tag: string) => htmlLangFor(choice, tag, TABLES);
