// Area catalogues (V2.5-27; needs 93): areas/<area>.ts add strings without editing index.ts; a key defined twice fails.
import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, mergeAreas, type AreaFile } from '../src/i18n';
import { TABLES } from '../src/i18n';

const legacy = () => ({ en: { 'a.legacy': 'Legacy' }, ko: { 'a.legacy': '레거시' }, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} });
const fixture: AreaFile = { en: { 'fx.hello': 'Hello {name}' }, ko: { 'fx.hello': '안녕 {name}' } };

test('area_catalogue_loads: a fixture area file renders English and Korean with no edit to index.ts', () => {
  const t = (lang: 'en' | 'ko') => makeT(lang, 'en', mergeAreas(legacy(), { './areas/fixture.ts': fixture }) as never) as (k: string, a?: Record<string, string>) => string;
  expect(t('en')('fx.hello', { name: 'Ada' })).toBe('Hello Ada');
  expect(t('ko')('fx.hello', { name: 'Ada' })).toBe('안녕 Ada');
  expect(makeT('ko', 'en', mergeAreas(legacy(), { './areas/fixture.ts': fixture }) as never)('a.legacy' as never)).toBe('레거시'); // legacy untouched
});

test('area_files_on_disk_merge: every real areas/*.ts merges cleanly against the legacy catalogues', async () => {
  const dir = fileURLToPath(new URL('../src/i18n/areas', import.meta.url));
  const files: Record<string, AreaFile> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) files[`./areas/${f}`] = await import(join(dir, f));
  const { en, ...rest } = TABLES as unknown as Record<string, Record<string, string>>;
  expect(() => mergeAreas({ en, ...rest } as never, files)).not.toThrow();
});

test('area_duplicate_key_fails: a key defined twice names both files', () => {
  const dup: AreaFile = { en: { 'fx.hello': 'Again' } };
  expect(() => mergeAreas(legacy(), { './areas/a.ts': fixture, './areas/b.ts': dup })).toThrow(/"fx\.hello" defined twice: \.\/areas\/a\.ts and \.\/areas\/b\.ts/);
  expect(() => mergeAreas(legacy(), { './areas/b.ts': { en: { 'a.legacy': 'x' } } })).toThrow(/legacy catalogue and \.\/areas\/b\.ts/);
});

test('area_translation_needs_english: a translation of a key the file does not define fails', () => {
  expect(() => mergeAreas(legacy(), { './areas/a.ts': { ko: { 'a.legacy': 'x' } } })).toThrow(/not one of its English keys/);
});
