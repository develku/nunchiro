// V2.5-54 A8 review MUST: the draft store is bounded: 100 KB a draft (the first 100 KB kept, never dropped whole), 50 drafts
// (the least recently written go first). Pure: the module needs no page.
import { expect, test } from '@playwright/test';
import { getDraft, setDraft } from '../src/composer-drafts';

test('composer_draft_store_is_bounded', () => {
  const big = 'a'.repeat(100_000) + 'TAIL'.repeat(1000);
  setDraft('big', big);
  expect(getDraft('big')).toBe('a'.repeat(100_000)); // the first 100 KB, not nothing
  setDraft('short', 'kept as typed');
  expect(getDraft('short')).toBe('kept as typed');
  for (let i = 0; i < 60; i++) setDraft(`s${i}`, `text ${i}`);
  // 50 at most: the oldest writes (big, short, s0..s9) are gone, the newest 50 stay
  expect(getDraft('big')).toBe('');
  expect(getDraft('s9')).toBe('');
  expect(getDraft('s10')).toBe('text 10');
  expect(getDraft('s59')).toBe('text 59');
  // writing again makes a draft the newest
  setDraft('s10', 'text 10 again');
  setDraft('new', 'n');
  expect(getDraft('s10')).toBe('text 10 again');
  expect(getDraft('s11')).toBe('');
});

test('composer_draft_cut_never_splits_a_surrogate_pair', () => {
  setDraft('emoji', 'a'.repeat(99_999) + '😀');
  expect(getDraft('emoji')).toBe('a'.repeat(99_999)); // the half emoji is dropped, no lone high surrogate
  const exact = 'b'.repeat(100_000);
  setDraft('exact', exact);
  expect(getDraft('exact')).toBe(exact);
});
