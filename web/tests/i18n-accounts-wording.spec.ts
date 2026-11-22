// ticket 191 items 3 and 4: wording of two Accounts tab strings (ja tabOpen, ko inUseByTab).
import { expect, test } from '@playwright/test';
import { makeT, mergeAreas, type AreaFile } from '../src/i18n';
import * as settingsBase from '../src/i18n/areas/settings-base';

const empty = { en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} };
const tables = mergeAreas(empty, { './areas/settings-base.ts': settingsBase as unknown as AreaFile });
const t = (lang: 'en' | 'ko' | 'ja') => makeT(lang, 'en', tables as never) as (k: string, a?: Record<string, string>) => string;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const raw = (lang: 'en' | 'ko' | 'ja', k: string) => t(lang)(k);

test('accounts_tab_open_ja_wording', () => {
  expect(t('ja')('settings.accounts.tabOpen', { tab: '2' })).toBe('タブが開いています：2');
});

test('accounts_in_use_by_tab_ko_wording', () => {
  const s = t('ko')('settings.accounts.inUseByTab', { label: 'a', tabs: '3' });
  expect(s).toContain('전용 탭 3');
  expect(s).not.toContain('자체 탭');
});

test('accounts_wording_keeps_placeholders', () => {
  expect(placeholders(raw('ja', 'settings.accounts.tabOpen'))).toEqual(placeholders(raw('en', 'settings.accounts.tabOpen')));
  expect(placeholders(raw('ko', 'settings.accounts.inUseByTab'))).toEqual(placeholders(raw('en', 'settings.accounts.inUseByTab')));
});
