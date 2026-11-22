// Ticket 297 item 6 (needs 213): the Board summary and a column's count say "1 card", not "1 cards". Real core, seeded cards.
import { expect, test } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';

test('board_summary_plural: the summary reads 2 cards, 1 card, 0 cards, and a column count says the same', async ({ app, core }) => {
  seed(core, [{ id: 'p1', title: 'Alpha', column: 'todo' }, { id: 'p2', title: 'Beta', column: 'working' }]);
  const board = await openBoard(app, core);
  const summary = board.locator('.bsummary');
  const search = board.getByRole('textbox', { name: 'Search cards' });
  await expect(summary).toHaveText('Board · 2 cards');
  await search.fill('alpha');
  await expect(summary).toHaveText('Board · 1 card');
  // The column holding it counts the same way (its aria-label; the digit is what shows).
  await expect(board.locator('.bcol[data-column="todo"] .bcount')).toHaveAttribute('aria-label', '1 card');
  await search.fill('no such thing');
  await expect(summary).toHaveText('Board · 0 cards');
  await expect(board.locator('.bcol[data-column="todo"] .bcount')).toHaveAttribute('aria-label', '0 cards');
});
