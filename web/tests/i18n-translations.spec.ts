import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { LANGUAGES, resolveLanguage, type Key } from '../src/i18n';
import { EN, TABLES, htmlLang, makeT } from './i18n-tables';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// owner 11-21 (ticket 1035): new strings are English only until the one pass before the release; a missing line shows
// English. So a language may lack only the keys named in i18n-pending.json (ticket 1146), holds no key English lacks,
// and the lines it has are whole with English's placeholders. The pending list only shrinks: a key translated since
// leaves it. Ticket 1035 empties it.
const PENDING: Record<string, string[]> = JSON.parse(readFileSync(new URL('./i18n-pending.json', import.meta.url), 'utf8'));

test('all_keys_all_languages: every key in every language or pending, none outside English, placeholders match', () => {
  const keys = Object.keys(EN).sort() as Key[];
  for (const { id } of LANGUAGES) {
    if (id === 'system') continue;
    const table = TABLES[id] ?? {};
    expect(Object.keys(table).filter((k) => !(k in EN)), id).toEqual([]);
    const have = keys.filter((k) => k in table);
    for (const key of have) {
      expect(table[key]?.trim(), `${id}: ${key}`).toBeTruthy();
      expect(placeholders(table[key]!), `${id}: ${key}`).toEqual(placeholders(EN[key]));
    }
    expect(htmlLang(id, 'en')).toBe(id);
    if (id === 'en') continue;
    expect(keys.filter((k) => !(k in table)), `${id}: missing keys not in tests/i18n-pending.json`).toEqual(PENDING[id] ?? []);
  }
});

for (const [tag, want] of [
  ['zh-Hans', 'zh-Hans'], ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'],
  ['zh-Hant', 'zh-Hant'], ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-MO', 'zh-Hant'],
]) {
  test(`chinese_detection: ${tag} → ${want}`, () => {
    expect(resolveLanguage('system', tag)).toBe(want);
    expect(resolveLanguage('system', tag.toUpperCase())).toBe(want);
  });
}

test('translated_messages: arguments stay data and a partial catalogue still falls back', () => {
  expect(makeT('ko', 'en')('composer.label', { name: 'Claude' })).toBe('Claude에게 메시지 보내기');
  expect(makeT('ja', 'en')('composer.send')).toBe('送信');
  const t = makeT('fr', 'en', { en: { hello: 'Hello {name}', bye: 'Bye' }, fr: { bye: 'Au revoir' } });
  expect(t('hello', { name: 'Codex' })).toBe('Hello Codex');
  expect(t('bye')).toBe('Au revoir');
});

test('locale_plural_rules: zero uses French and Portuguese singular; many uses other', () => {
  const fr = makeT('fr', 'en');
  expect(fr('tree.projects.other', { n: 0 })).toBe('0 projet');
  expect(fr('tree.projects.other', { n: 1 })).toBe('1 projet');
  expect(fr('tree.projects.one', { n: 2 })).toBe('2 projets');
  expect(fr('tree.projects.other', { n: 1_000_000 })).toBe('1000000 projets');
  expect(makeT('pt', 'en')('tree.projects.other', { n: 0 })).toBe('0 projeto');
  expect(makeT('es', 'en')('tree.projects.other', { n: 0 })).toBe('0 proyectos');
  // Some old singular entries spell out 1 and deliberately have no {n} placeholder.
  expect(fr('settings.accounts.loss.other', { n: 0 })).toContain('0');
});

test('permission_refusal_wording: commands that spawn children are refused', () => {
  expect(makeT('zh-Hans', 'en')('approval.spawnAfter')).toBe('创建子进程的命令将被拒绝。');
  expect(makeT('zh-Hant', 'en')('approval.spawnAfter')).toBe('建立子處理程序的指令將被拒絕。') // Q5 11-20: Microsoft zh-TW 處理程序 for process;
});

// Ticket 500: Chinese UI text uses full-width punctuation; Japanese keeps the catalogue's ASCII ':' and '()' but not '?'/'!'.
// Only punctuation touching CJK text (or parentheses around it) counts, so commands, paths and {x} lists stay ASCII.
test('cjk_punctuation: no ASCII comma, colon, semicolon, question mark or parentheses beside Chinese; no ASCII ?/! after Japanese', () => {
  const cjk = '[\\u3040-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef]';
  const zh = new RegExp(`${cjk}[,;?!]|[,;] ?${cjk}|${cjk}:|:${cjk}|\\((?=[^)]*${cjk})[^)]*\\)`);
  const ja = new RegExp(`${cjk}[?!]`);
  const bad: string[] = [];
  for (const [id, re] of [['zh-Hans', zh], ['zh-Hant', zh], ['ja', ja]] as const) {
    for (const [key, text] of Object.entries(TABLES[id] ?? {})) {
      // searchWords.* (ticket 516) is never shown: settings search matches it as a substring, so its comma is no UI text (ticket 531).
      if (!key.startsWith('searchWords.') && re.test(text as string)) bad.push(`${id} ${key}: ${text}`);
    }
  }
  expect(bad).toEqual([]);
});
