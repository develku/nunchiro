// Look 1117 v4f (B-S2-1): the Board's DONE cards showed a lead's merge text with raw ** and backticks. A card's note reads
// as plain words, as the Board's other texts do.
import { expect, test } from '@playwright/test';
import { unmark } from '../src/board/tasks';

test('board_note_reads_as_plain_words', () => {
  expect(unmark("**-> Greet is merged.** `main` now has commit `612b3f0`.")).toBe('-> Greet is merged. main now has commit 612b3f0.');
  expect(unmark('## Done\n_kept_ the test')).toBe('Done\nkept the test');
  expect(unmark('See [the PR](https://x.test/1) and ![shot](a.png)')).toBe('See the PR and shot');
  expect(unmark('a*b and 2*3')).toBe('a*b and 2*3'); // a lone star stays
});

test('board_note_unmark_is_bounded: an agent note of 64 KiB (brackets, stars, ticks, one line or many) is stripped in under 50 ms and comes back whole', () => {
  const notes = ['[', '[a', '**', '`', '_a'].map((u) => u.repeat(65_536 / u.length));
  notes.push(`${'**'.repeat(100)}\n`.repeat(65_536 / 201), `${'[a'.repeat(100)}\n`.repeat(65_536 / 201));
  for (const text of notes) {
    const t0 = performance.now();
    const out = unmark(text);
    expect(performance.now() - t0).toBeLessThan(50);
    if (!text.includes('\n')) expect(out.slice(-60_000)).toBe(text.slice(-60_000)); // past a line's first 200: kept as is
  }
  expect(unmark('x'.repeat(5000))).toBe('x'.repeat(5000));
});
