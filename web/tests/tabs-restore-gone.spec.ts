// Ticket 448 (Tabs item): a window restored with a tab whose session the core does not know, and a past-conversation tab never
// read in this run. The shown tab was the one that went, so the empty landing covered the tabs left, and the conversation's
// tab was named by its file stem, a raw id.
import { expect, openWindow, test } from './fixtures';

const GONE = '11111111-2222-4333-8444-555555555555';
const STEM = '18c7a5f2-fdb5-4de3-95aa-000000000000';

test('restored_tabs: a gone session tab leaves, a tab left is shown, and an unread conversation has a plain name', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'work');
  await openWindow(app, {}, core);
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
  await app.evaluate(
    ([gone, live, imported]) => {
      for (const k of Object.keys(localStorage).filter((k) => k.startsWith('nunchiro.window.v1'))) {
        const v = JSON.parse(localStorage.getItem(k) ?? '{}');
        localStorage.setItem(k, JSON.stringify({ ...v, tabs: [live, gone, imported], active: gone }));
      }
    },
    [GONE, s.id, `imported:claude:${STEM}`],
  );
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await expect(app.locator(`.tab[data-tab="${GONE}"]`)).toHaveCount(0);
  // The tab before the one that went is shown, not the landing.
  await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toHaveAttribute('aria-selected', 'true');
  const past = app.locator(`.tab[data-tab="imported:claude:${STEM}"]`);
  await expect(past).toContainText('Untitled conversation');
  await expect(past).not.toContainText(STEM.slice(0, 8));
});
