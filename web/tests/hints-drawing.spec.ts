// Settings > Keys > Hints keyboard drawing (V1A-56; needs 64): a key shows its glyph and a colour dot per placed kind
// or icon, the names sit in a legend, nothing reads under 11 px, and text and dots hold contrast on every built-in theme.
import { contrast } from '../src/themes/derive';
import { windowTokens } from './window-tokens';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test } from './fixtures';

// Ticket 293 (needs 212): catalog themes are applied as written, with no contrast push, so only the bundled pair (tokens.css) promises these ratios.
const BUILT_IN = [LIGHT_PICK, DARK_PICK];
const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;

test('hints-drawing-legend: on the Hints tab a key shows glyph + dots, names in a legend, no text under 11 px, contrast on every theme', async ({ app, core }) => {
  core.shell(core.project('demo'), 'one');
  await openWindow(app);
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Keyboard' }).click();
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  await app.locator('details.hk-adv > summary').click(); // final.html: the drawing is in the closed Advanced fold
  const board = app.locator('.sbody').getByRole('group', { name: 'Keyboard' });
  await expect(board).toBeVisible();

  // Every kind is in the legend with its key, and the label keys have their own entry (V1A-57).
  const legend = app.getByRole('list', { name: 'Keys on the drawing' }).getByRole('listitem');
  const items = (await legend.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  expect(items.filter((t) => t.includes('Hint keys'))).toEqual(['a d f j k l g h e w r u i o q t y v c m n x z b 1 2 3 4 5 6 7 8 9 0 Hint keys (labels use these, in this order)']);
  // Ticket 389: p and s start project and session labels; the other kind keys are Shift filters.
  expect(items.filter((t) => / labels start here$| only$/.test(t))).toEqual(['p1 Projects labels start here', 's1 Sessions labels start here', '⇧t Shift+t: Tabs only', '⇧l Shift+l: Left bar icons only', '⇧r Shift+r: Right bar icons only', '⇧w Shift+w: Panes and splits only', '⇧f Shift+f: Files and paths only', '⇧u Shift+u: URLs only', '⇧h Shift+h: Commit IDs (hashes) only', '⇧o Shift+o: Other only']);
  expect(items.filter((t) => / bar$|composer$/.test(t))).toEqual(['left bar', 'top bar', 'right bar', 'composer']);

  // On the Hints tab a key face is its glyph only (the Key map tab names commands): hint names live in the legend.
  await expect(board.locator('[data-code="Digit1"]')).toHaveText('1');
  await expect(board.locator('[data-code="Backquote"]')).toHaveText('`');
  await expect(board.locator('[data-code="Backslash"]')).toHaveText('\\');
  // The prefix keys read p1 and s1 on their face and are not label keys.
  await expect(board.locator('[data-code="KeyP"]')).toHaveText('p1');
  await expect(board.locator('[data-code="KeyP"] .dot')).toHaveCount(1);
  await expect(board.locator('[data-code="KeyP"]')).toHaveAttribute('aria-label', /^p: Projects labels start here$/);
  // w is a Shift filter and a label key of the top bar region: its name says all three, and its colour bar is the region's.
  await expect(board.locator('[data-code="KeyW"]')).toHaveAttribute('aria-label', /^w: Shift\+w: Panes and splits only, label key \d+, top bar$/);
  await expect(board.locator('[data-code="KeyW"]')).toHaveAttribute('data-region', 'top');
  await expect(board.locator('[data-code="KeyZ"]')).toHaveAttribute('data-region', 'composer');
  await expect(board.locator('[data-code="Digit1"]')).not.toHaveAttribute('data-region', /./);
  await expect(board.locator('[data-code="Digit1"] .dot[data-type="index"]')).toHaveCount(1);
  await expect(board.locator('.dot[data-type="kind"]')).toHaveCount(2);
  await expect(board.locator('.dot[data-type="filter"]')).toHaveCount(8);

  const small = await board.evaluate((b) =>
    [...b.querySelectorAll('*')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 11).map((e) => e.outerHTML),
  );
  expect(small).toEqual([]);

  const low: string[] = [];
  const seen = new Set<string>();
  for (const t of BUILT_IN) {
    const m = await board.evaluate((b, tokens) => {
      for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
      // The surface behind an element: its nearest ancestor with an opaque background (as contrast.spec.ts).
      const behind = (e: Element | null): string => {
        for (; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (!/rgba\(.*, 0\)$|transparent/.test(c)) return c;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const dots = (scope: Element, bg: string) =>
        [...scope.querySelectorAll('.dot')].map((d) => ({ part: `${(d as HTMLElement).dataset.type} dot`, fg: getComputedStyle(d).backgroundColor, bg, min: 3 }));
      const keys = [...b.querySelectorAll('.hk-key')].flatMap((k) => {
        const bg = getComputedStyle(k).backgroundColor;
        return [{ part: 'glyph', fg: getComputedStyle(k.querySelector('.g')!).color, bg, min: 4.5 }, ...dots(k, bg)];
      });
      const legend = [...document.querySelectorAll('.hk-legend li')].flatMap((li) => {
        const bg = behind(li);
        return [{ part: 'legend text', fg: getComputedStyle(li).color, bg, min: 4.5 }, ...dots(li, bg)];
      });
      return [...keys, ...legend];
    }, windowTokens(t.colors));
    seen.add(contrast('#ffffff', t.colors.background) > contrast('#000000', t.colors.background) ? 'dark' : 'light');
    for (const p of m) {
      const ratio = contrast(hex(p.fg), hex(p.bg));
      if (ratio < p.min) low.push(`${t.name} ${p.part}: ${hex(p.fg)} on ${hex(p.bg)} = ${ratio.toFixed(2)}:1`);
    }
  }
  expect([...seen].sort()).toEqual(['dark', 'light']);
  expect([...new Set(low)]).toEqual([]);
});
