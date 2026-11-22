// Ticket 352: with no agent session the Browser icon draws the user's own browser in its bar's sidebar, over the widget open
// there. Both icons were lit, and pressing the covered widget's icon closed the sidebar and the browser with it.
import { expect, openWindow, test } from './fixtures';
import { sidebar } from './d5b';

test('browser_over_widget: only the shown one is lit, and the covered widget\'s icon brings it back', async ({ app, core }) => {
  await openWindow(app, {}, core);
  const diff = app.locator('#icon-diff');
  const browser = app.locator('#icon-browser');
  if ((await diff.getAttribute('aria-pressed')) !== 'true') await diff.click();
  await expect(sidebar(app, 'right')).toHaveAttribute('data-widget', 'diff');

  await browser.click();
  await expect(sidebar(app, 'right')).toHaveAttribute('data-widget', 'browser');
  await expect(browser).toHaveAttribute('aria-pressed', 'true');
  await expect(diff).toHaveAttribute('aria-pressed', 'false'); // covered, so not lit

  // The covered widget's icon shows it again; it used to close the sidebar.
  await diff.click();
  await expect(sidebar(app, 'right')).toHaveAttribute('data-widget', 'diff');
  await expect(diff).toHaveAttribute('aria-pressed', 'true');
  await expect(browser).toHaveAttribute('aria-pressed', 'false');

  // Browser pressed twice: the widget under it is back, lit.
  await browser.click();
  await browser.click();
  await expect(sidebar(app, 'right')).toHaveAttribute('data-widget', 'diff');
  await expect(diff).toHaveAttribute('aria-pressed', 'true');
});
