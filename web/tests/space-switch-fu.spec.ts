// V2.5-82 (v25-space-switch-fu): the Browser space switcher has a hover name, and a space another mounted pane shows is listed
// but disabled (one native webview per space). The native webview is not visible here, so the rule is proved on the DOM: the
// option state and which BrowserView is mounted (its address bar). The blank-pane effect itself is not proven (REPORT).
// Two panes in one window exist only in the suite's fixture page (tests/feature-fixtures/space-switch-panes.tsx).
import type { Page } from '@playwright/test';
import { expect, openWindow, test } from './fixtures';
import { TABLES } from './i18n-tables';

const LANGUAGES = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const;
const t = (lang: string, key: string) => (TABLES as Record<string, Record<string, string>>)[lang][key];

async function twoPanes(app: Page, language = 'en') {
  await app.addInitScript((l) => {
    (window as { __NUNCHIRO_SPACE_FIXTURE__?: boolean }).__NUNCHIRO_SPACE_FIXTURE__ = true;
    const k = 'nunchiro.settings.v1';
    localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), language: l }));
  }, language);
  if (language === 'en') await openWindow(app);
  else await app.goto('/'); // openWindow waits for an English status line
  await expect(app.locator('html')).toHaveAttribute('lang', language);
  await app.locator('[data-hint-icon="settings.open"]').click();
  await app.getByRole('button', { name: 'Space switch panes' }).click(); // the fixture page's English title
}
const pane = (app: Page, name: 'Pane A' | 'Pane B') => app.getByRole('region', { name });

test.beforeEach(({ core }) => void core.shell(core.project('demo'), 'x'));

for (const lang of LANGUAGES)
  test(`space_switcher_has_hover_name: ${lang}`, async ({ app }) => {
    await twoPanes(app, lang);
    const name = t(lang, 'exitWidgets.spaces');
    const switcher = pane(app, 'Pane A').getByLabel(name);
    await expect(switcher).toHaveAttribute('data-tip', name);
    await switcher.hover();
    await expect(app.getByRole('tooltip')).toHaveText(name);
  });

test('space_shown_elsewhere_is_disabled: the space the other pane shows is listed, disabled, with its reason', async ({ app }) => {
  await twoPanes(app);
  const a = pane(app, 'Pane A').getByLabel('Browser space');
  const b = pane(app, 'Pane B').getByLabel('Browser space');
  await expect(a).toHaveValue('sa');
  await expect(b).toHaveValue('sb');
  await expect(a.locator('option')).toHaveText(['My browser', 'alpha (agent)', 'beta (agent) - shown in another pane']);
  await expect(a.locator('option[value="sb"]')).toBeDisabled();
  await expect(a.locator('option[value="sa"]')).toBeEnabled();
  await expect(a.locator('option[value="you"]')).toBeEnabled();
  await expect(b.locator('option')).toHaveText(['My browser', 'alpha (agent) - shown in another pane', 'beta (agent)']);
  // A pane's own space and My browser stay pickable, and a pick taken by the other pane is then disabled for it.
  await a.selectOption('you');
  await expect(b.locator('option[value="you"]')).toBeDisabled();
  await expect(b.locator('option[value="you"]')).toHaveText('My browser - shown in another pane');
  await expect(b.locator('option[value="sa"]')).toBeEnabled(); // pane A left its own space
  await expect(a.locator('option[value="sa"]')).toBeEnabled();
});

test('space_taken_falls_back_to_own: closing the other pane enables its space again; a taken pick falls back', async ({ app }) => {
  await twoPanes(app);
  const a = pane(app, 'Pane A').getByLabel('Browser space');
  // Closing pane B frees its space.
  await expect(a.locator('option[value="sb"]')).toBeDisabled();
  await app.getByRole('button', { name: 'Close pane B' }).click();
  await expect(a.locator('option[value="sb"]')).toBeEnabled();
  await expect(a.locator('option[value="sb"]')).toHaveText('beta (agent)');
  // Pane A picks B's space while B is closed; B opening takes it back: A falls back to its own space, B keeps its own.
  await a.selectOption('sb');
  await expect(a).toHaveValue('sb');
  await app.getByRole('button', { name: 'Open pane B' }).click();
  const b = pane(app, 'Pane B').getByLabel('Browser space');
  await expect(b).toHaveValue('sb');
  await expect(a).toHaveValue('sa');
  await expect(a.locator('option[value="sb"]')).toBeDisabled();
  // Only one pane has a view on that space: each of the two shows its own address bar once.
  await expect(pane(app, 'Pane A').getByLabel('Address')).toHaveCount(1);
  await expect(pane(app, 'Pane B').getByLabel('Address')).toHaveCount(1);
});
