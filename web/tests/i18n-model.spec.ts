// UI language model (V2-14a; needs 93): the catalogue's per-string fallback, the System resolution, the stored choice. Pure, no page.
import { expect, test } from '@playwright/test';
import { LANGUAGES, makeT, resolveLanguage } from '../src/i18n';
import { DEFAULTS, parse } from '../src/settings';
import { summaryLabel } from '../src/chat/model';
import { TABLES } from './i18n-tables';

test('catalogue_falls_back_per_string: a missing key shows English, a present key its own string', () => {
  const tables = { en: { hello: 'Hello', bye: 'Bye {who}' }, ko: { hello: '안녕' } };
  const t = makeT('ko', 'en-US', tables);
  expect(t('hello')).toBe('안녕');
  expect(t('bye', { who: 'Ada' })).toBe('Bye Ada');
  expect(makeT('fr', 'en-US', tables)('hello')).toBe('Hello'); // no table at all for French
  expect(makeT('en', 'ko-KR', tables)('hello')).toBe('Hello');
});

test('system_language_resolution: navigator.language maps to one of the nine choices', () => {
  const table: [string, string][] = [
    ['en-US', 'en'], ['en', 'en'], ['ko-KR', 'ko'], ['ko', 'ko'], ['ja-JP', 'ja'],
    ['zh-CN', 'zh-Hans'], ['zh-SG', 'zh-Hans'], ['zh-Hans-CN', 'zh-Hans'], ['zh', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'], ['zh-HK', 'zh-Hant'], ['zh-Hant', 'zh-Hant'], ['zh-Hant-TW', 'zh-Hant'],
    ['es-419', 'es'], ['fr-CA', 'fr'], ['pt-BR', 'pt'], ['pt-PT', 'pt'],
    ['de-DE', 'en'], ['xx', 'en'], ['', 'en'],
  ];
  for (const [tag, want] of table) expect(resolveLanguage('system', tag), tag).toBe(want);
  expect(resolveLanguage('ja', 'ko-KR')).toBe('ja'); // a picked language ignores the system
  expect(LANGUAGES.map((l) => l.id)).toEqual(['system', 'en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt']);
});

test('language_setting_persists (model): default System; a stored choice round-trips; a bad value parses back to System', () => {
  expect(DEFAULTS.language).toBe('system');
  expect(parse(null).settings.language).toBe('system');
  expect(parse(JSON.stringify({ language: 'ko' }))).toMatchObject({ settings: { language: 'ko' }, clean: true });
  for (const bad of ['klingon', 7, null, 'KO']) expect(parse(JSON.stringify({ language: bad })), String(bad)).toMatchObject({ settings: { language: 'system' }, clean: false });
});

test('korean_particles_follow_the_inserted_word (Q5): no "glab이(가)", the form for the word last sound', () => {
  const tables = { en: { a: '{x} a', b: '{x} b', c: '{x} c', d: '{x} d', e: '“{x}”e' }, ko: { a: '{x}이(가) 없습니다', b: '{x}을(를) 엽니다', c: '{x}(으)로 로그인됨', d: '{x}와(과) 함께', e: '“{x}”은(는)' } };
  const t = makeT('ko', 'ko', tables);
  const cases: [string, Record<string, string>][] = [
    ['glab', { a: 'glab이 없습니다', b: 'glab을 엽니다', c: 'glab으로 로그인됨', d: 'glab과 함께', e: '“glab”은' }],
    ['Claude', { a: 'Claude가 없습니다', b: 'Claude를 엽니다', c: 'Claude로 로그인됨', d: 'Claude와 함께', e: '“Claude”는' }],
    ['tea login add', { a: 'tea login add가 없습니다', b: 'tea login add를 엽니다' }],
    ['nunchiro', { c: 'nunchiro로 로그인됨' }],
    ['owner-mail', { c: 'owner-mail로 로그인됨', a: 'owner-mail이 없습니다' }],
    ['Copilot', { a: 'Copilot이 없습니다' }],
    ['Chrome', { a: 'Chrome이 없습니다' }],
    ['눈치', { a: '눈치가 없습니다' }],
    ['프로젝트', { b: '프로젝트를 엽니다' }],
    ['서울', { c: '서울로 로그인됨', a: '서울이 없습니다' }],
    ['버전 3', { a: '버전 3이 없습니다' }],
    ['v2', { a: 'v2가 없습니다' }],
    ['~/a/', { a: '~/a/이(가) 없습니다' }], // unknown ending: the template form stays
  ];
  for (const [x, want] of cases) for (const [k, v] of Object.entries(want)) expect(t(k as 'a', { x }), `${x} ${k}`).toBe(v);
  expect(makeT('ja', 'ja', { en: { a: '{x}' }, ja: { a: '{x}이(가)' } })('a', { x: 'glab' })).toBe('glab이(가)'); // Korean only
});

test('q5_wording: es ages are lowercase inside a sentence, ja "{page}を開く" has no stray space', () => {
  const es = makeT('es', 'es', TABLES);
  expect(es('providers.checked', { age: es('chat.pr.justNow') })).toBe('Comprobado ahora mismo');
  expect(makeT('ja', 'ja', TABLES)('onboarding.open', { page: '通知' })).toBe('通知を開く');
});

test('turn_summary_in_the_window_language (Q5): "Used 1 other tool" was an English literal', () => {
  const parts: Parameters<typeof summaryLabel>[0] = [['read', 2], ['edited', 1], ['other', 1]];
  expect(summaryLabel(parts, makeT('en', 'en', TABLES))).toBe('Read 2 files, edited 1 file, used 1 other tool');
  expect(summaryLabel(parts, makeT('ko', 'ko', TABLES))).toBe('파일 2개 읽음, 파일 1개 편집, 다른 도구 1개 사용');
  expect(summaryLabel([['other', 3]], makeT('es', 'es', TABLES))).toBe('Usó 3 herramientas más');
  expect(makeT('ja', 'ja', TABLES)('picker.switchFailed')).not.toMatch(/switch failed/i);
});
