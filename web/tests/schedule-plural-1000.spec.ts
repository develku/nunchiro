// Ticket 1000: a schedule row's next run counts hours and days in the language's plural form ("in 1 hour", never "in 1 hours").
import { expect, test } from '@playwright/test';
import { nextWords, type Schedule } from '../src/schedule/schedules';
import { makeT } from './i18n-tables';

const now = Date.UTC(2026, 10, 20, 12);
const at = (min: number): Schedule => ({ id: 's', run: { kind: 'claude', project: '/p', label: '' }, at: '09:00', daily: true, next_ms: now + min * 60_000 });

test('schedule_next_run_plurals: one hour, two hours, one day in English, French and Portuguese', () => {
  const words = (lang: 'en' | 'fr' | 'pt', min: number) => nextWords(makeT(lang, 'en'), at(min), now);
  expect(words('en', 60)).toBe('in 1 hour');
  expect(words('en', 120)).toBe('in 2 hours');
  expect(words('en', 24 * 60)).toBe('in 1 day');
  expect(words('en', 3 * 24 * 60)).toBe('in 3 days');
  expect(words('fr', 60)).toBe('dans 1 heure');
  expect(words('fr', 120)).toBe('dans 2 heures');
  expect(words('pt', 24 * 60)).toBe('em 1 dia');
  expect(words('pt', 2 * 24 * 60)).toBe('em 2 dias');
  expect(nextWords(makeT('ko', 'en'), at(60), now)).toBe('1시간 뒤');
});
