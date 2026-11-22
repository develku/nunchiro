// Rail names (coordinator finding, real app 2026-11-11): an accessibility client found the icon bars' buttons without
// names. Every icon button in both bars, the bars themselves and their hide / show buttons carry a name from the catalogue,
// in every shipped language.
import { LANGUAGES, makeT, mergeAreas, type Key, type Language } from '../src/i18n';
import * as shell from '../src/i18n/areas/shell';
import * as chrome from '../src/i18n/areas/shell-chrome';
import { expect, test } from './fixtures';

// Node has no import.meta.glob, so the catalogue is the two area files these names come from.
const TABLES = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { shell, chrome });
const LEFT = ['tree', 'files', 'search', 'settings'];
const RIGHT = ['board', 'decisions', 'terminal', 'browser', 'diff', 'artifacts', 'layout'];

test('rail_icons_have_names_in_every_language', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await app.goto('/');
  for (const { id } of LANGUAGES.filter((l) => l.id !== 'system')) {
    const t = makeT<Key>(id as Language, 'en', TABLES as never);
    await app.evaluate((language) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language })), id);
    await app.reload();
    await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
    for (const [side, icons] of [
      ['left', LEFT],
      ['right', RIGHT],
    ] as const) {
      const bar = app.getByRole('navigation', { name: t(side === 'left' ? 'shell.rail.left' : 'shell.rail.right'), exact: true });
      await expect(bar, `${id} ${side} bar`).toBeVisible();
      for (const w of icons) await expect(bar.getByRole('button', { name: t(`shell.widget.${w}` as Key), exact: true }), `${id} ${w}`).toBeVisible();
      // Every icon button in the bar has a name (none is left to its glyph).
      for (const b of await bar.locator('.ai').all()) expect((await b.getAttribute('aria-label'))?.trim(), `${id} ${side}`).toBeTruthy();
    }
    // The hide / show buttons at each bar's top: the left sidebar starts open (Tree), the right one closed.
    await expect(app.getByRole('button', { name: t('shell.chrome.hideLeft'), exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: t('shell.chrome.showRight'), exact: true })).toBeVisible();
  }
});
