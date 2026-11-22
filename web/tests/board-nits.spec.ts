// Ticket 304 (V2.5-82 nits): the board legend's aria-label names what the legend shows (a state key of three cues, not a
// colour key), and the per-colour strings the redraw left behind are gone from the catalogue.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK } from '../src/themes/nunchiro';
import { expect, test, type Core } from './fixtures';
import { openBoard, seed } from './fixtures/board/coord';
import { EN, TABLES } from './i18n-tables';

const LABEL = 'State key';
const shotsDir = process.env.SHOTS_DIR;
const web = path.resolve(import.meta.dirname, '..');

// Dracula and Solarized Light as the board-polish spec imports them: the themes where an "orange" or "yellow" word was wrong.
const scheme = (bg: string, fg: string, sel: string, pal: string[]) =>
  [`background = ${bg}`, `foreground = ${fg}`, `selection-background = ${sel}`, ...pal.map((c, i) => `palette = ${i}=${c}`)].join('\n') + '\n';
const imported = (name: string, ghostty: string) => ({ id: `imported:${name}`, name, colors: parseGhostty(ghostty), source: `https://example.invalid/${encodeURIComponent(name)}` });
const PICKS = [
  imported('Dracula', scheme('#282a36', '#f8f8f2', '#44475a', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'])),
  imported('Solarized Light', scheme('#fdf6e3', '#657b83', '#eee8d5', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#bbb5a1', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'])),
  DARK_PICK,
];

async function boardIn(app: Page, core: Core, pick: object) {
  seed(core, [{ id: 'c1', title: 'Write the report', column: 'todo' }]);
  await app.emulateMedia({ colorScheme: 'light' });
  await app.addInitScript((p) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ themeMode: 'fixed', themeFixed: p })), pick);
  return openBoard(app, core);
}

for (const pick of PICKS)
  test(`board_legend_label_matches_cues: ${pick.name} labels the legend "${LABEL}" and shows the hand, clock and x-circle with a word each`, async ({ app, core }) => {
    const board = await boardIn(app, core, pick);
    const key = board.getByRole('group', { name: LABEL });
    await expect(key).toBeVisible();
    // The label does not name colour only (the old "Colour key" named the legend by what it no longer draws).
    expect(await key.getAttribute('aria-label')).not.toMatch(/colou?r|색|色|颜|顏|cor|couleur/i);
    await expect(key.locator('[data-k]')).toHaveText(['your turn', 'stale', 'broken']);
    for (const [k, glyph] of [['you', 'hand'], ['stale', 'clock'], ['bad', 'fail']] as const)
      await expect(key.locator(`[data-k="${k}"] i svg`)).toHaveAttribute('data-icon', glyph);
    if (shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      await key.screenshot({ path: path.join(shotsDir, `legend-${pick.name.replace(/\W+/g, '-')}.png`) });
      console.log(`${pick.name}: aria-label="${await key.getAttribute('aria-label')}"`);
    }
  });

test('board_key_i18n_keys_unused_removed: none of the four per-colour key strings appears under web/src or web/tests', () => {
  const dead = ['board.key.' + 'label', 'board.key.' + 'you', 'board.key.' + 'stale', 'board.key.' + 'bad'];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) e.name !== 'node_modules' && walk(p);
      else if (/\.(tsx?|css|json)$/.test(e.name) && dead.some((k) => fs.readFileSync(p, 'utf8').includes(k))) hits.push(path.relative(web, p));
    }
  };
  walk(path.join(web, 'src'));
  walk(path.join(web, 'tests'));
  expect(hits).toEqual([]);
});

test('board_nits_i18n_8_languages: the legend label has a non-empty text in en, ko, ja, zh-Hans, zh-Hant, es, fr and pt', () => {
  expect(EN['board.legend.label' as keyof typeof EN]).toBe(LABEL);
  for (const id of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const)
    expect((TABLES as unknown as Record<string, Record<string, string>>)[id]['board.legend.label']?.trim(), id).toBeTruthy();
});
