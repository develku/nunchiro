// V2.5-33b (ticket 167): moving catalogues between files never drops a key; the baseline is the key set per language at the move.
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeAreas, type AreaFile } from '../src/i18n';

test('no_key_dropped: every language keeps at least its baseline keys', async () => {
  const dir = fileURLToPath(new URL('../src/i18n/areas', import.meta.url));
  const files: Record<string, AreaFile> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) files[`./areas/${f}`] = await import(join(dir, f));
  const empty = { en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} };
  const built = mergeAreas(empty, files);
  const baseline: Record<string, string[]> = JSON.parse(readFileSync(new URL('./i18n-key-sets.json', import.meta.url), 'utf8'));
  for (const [lang, keys] of Object.entries(baseline)) expect(keys.filter((k) => !(k in built[lang as keyof typeof built])), lang).toEqual([]);
});

test('legacy_files_gone: no flat locale file remains in src/i18n', () => {
  const dir = fileURLToPath(new URL('../src/i18n', import.meta.url));
  expect(readdirSync(dir).filter((n) => n.endsWith('.ts'))).toEqual(['index.ts']);
});
