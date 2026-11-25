// V1A-52: the tab close x and the section drag handle are UI parts: each reads at >= 3:1 (WCAG 1.4.11) against the
// surface behind it in every built-in theme, light and dark. Measured from getComputedStyle in the real window; the
// theme's tokens go on <html> as useTheme puts them there.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { contrast } from '../src/themes/derive';
import { windowTokens } from './window-tokens';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

// Ticket 293 (needs 212): catalog themes are applied as written, with no contrast push, so only the bundled pair (tokens.css) promises these ratios.
const BUILT_IN = [LIGHT_PICK, DARK_PICK];

test('contrast-close-handle: close x and drag handle reach 3:1 on their background in every built-in theme', async ({ app, core }) => {
  const demo = core.project('demo');
  core.shell(demo, 'a');
  core.shell(demo, 'b'); // one tab selected (--bg), one not (the strip's --g1)
  await openWindow(app);
  const parts = { 'close x': '.tabw > .x', 'drag handle': '.ph .grip' };
  for (const sel of Object.values(parts)) await expect(app.locator(sel).first()).toBeAttached();
  const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  const low: string[] = [];
  const seen = new Set<string>();
  for (const t of BUILT_IN) {
    const measured = await app.evaluate(
      ({ tokens, parts }) => {
        for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
        // The surface behind an element: its ancestors' backgrounds laid over each other up to the first opaque one (ticket
        // 1041: the selected tab is a translucent tint step over the panel).
        const behind = (e: Element | null): string => {
          const layers: number[][] = [];
          for (; e; e = e.parentElement) {
            const v = (getComputedStyle(e).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
            const a = v.length > 3 ? v[3] : 1;
            if (a > 0) layers.push([v[0], v[1], v[2], a]);
            if (a >= 1) break;
          }
          if (!layers.length || layers.at(-1)![3] < 1) layers.push([...(getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number), 1]);
          const [r, g, b] = layers.reduceRight((under, [lr, lg, lb, la]) => [lr * la + under[0] * (1 - la), lg * la + under[1] * (1 - la), lb * la + under[2] * (1 - la)], [0, 0, 0]);
          return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
        };
        return Object.entries(parts).flatMap(([name, sel]) =>
          [...document.querySelectorAll(sel)].map((e) => ({ name, fg: getComputedStyle(e).color, bg: behind(e.parentElement) })),
        );
      },
      { tokens: windowTokens(t.colors), parts },
    );
    for (const m of measured) {
      seen.add(`${m.name}:${contrast('#ffffff', t.colors.background) > contrast('#000000', t.colors.background) ? 'dark' : 'light'}`);
      const ratio = contrast(hex(m.fg), hex(m.bg));
      if (ratio < 3) low.push(`${t.name} ${m.name}: ${hex(m.fg)} on ${hex(m.bg)} = ${ratio.toFixed(2)}:1`);
    }
  }
  expect(BUILT_IN.length).toBe(2);
  expect([...seen].sort()).toEqual(['close x:dark', 'close x:light', 'drag handle:dark', 'drag handle:light']);
  expect(low).toEqual([]);
});

test('copy-badge-contrast: the copy mode badge text reaches 4.5:1 on its own background in every built-in theme', async ({ app, core }) => {
  core.replay(core.project('demo'), 'a', 'some text');
  await openWindow(app);
  await app.locator('.term').first().click();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('BracketLeft');
  await expect(app.locator('.copy-status')).toBeVisible();
  const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  const low: string[] = [];
  const seen = new Set<string>();
  for (const t of BUILT_IN) {
    const m = await app.evaluate((tokens) => {
      for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
      const s = getComputedStyle(document.querySelector('.copy-status')!);
      return { fg: s.color, bg: s.backgroundColor };
    }, windowTokens(t.colors));
    seen.add(contrast('#ffffff', t.colors.background) > contrast('#000000', t.colors.background) ? 'dark' : 'light');
    expect(m.bg, `${t.name}: the badge has an opaque background`).not.toMatch(/rgba\(.*, 0\)$|transparent/);
    const ratio = contrast(hex(m.fg), hex(m.bg));
    if (ratio < 4.5) low.push(`${t.name}: ${hex(m.fg)} on ${hex(m.bg)} = ${ratio.toFixed(2)}:1`);
  }
  expect([...seen].sort()).toEqual(['dark', 'light']);
  expect(low).toEqual([]);
});

// V1B-42..45 (design QA M1, M2, M4). In-page measure: the computed text colour over the first opaque ancestor background,
// as the V1B-41 QA did. `sel` picks the elements; each one's own text node (or the glyph it holds) is the text run.
const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
const MODES = [
  ['light', LIGHT_PICK],
  ['dark', DARK_PICK],
] as const;

/** Puts a theme's tokens on <html> and the OS scheme with them, so the static diff tints follow the theme. */
async function themed(page: Page, scheme: 'light' | 'dark', tokens: Record<string, string>) {
  await page.emulateMedia({ colorScheme: scheme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
  await page.evaluate((tk) => Object.entries(tk).forEach(([k, v]) => document.documentElement.style.setProperty(k, v)), tokens);
}

/** Ratio of each text run under `sel` against the opaque surface behind it; skips elements that are not shown. */
async function runs(page: Page, sel: string) {
  const found = await page.evaluate((s) => {
    // The ancestors' backgrounds laid over each other up to the first opaque one (ticket 1041: tint steps are translucent).
    const behind = (e: Element | null): string => {
      const layers: number[][] = [];
      for (; e; e = e.parentElement) {
        const v = (getComputedStyle(e).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
        const a = v.length > 3 ? v[3] : 1;
        if (a > 0) layers.push([v[0], v[1], v[2], a]);
        if (a >= 1) break;
      }
      if (!layers.length || layers.at(-1)![3] < 1) layers.push([...(getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number), 1]);
      const [r, g, b] = layers.reduceRight((under, [lr, lg, lb, la]) => [lr * la + under[0] * (1 - la), lg * la + under[1] * (1 - la), lb * la + under[2] * (1 - la)], [0, 0, 0]);
      return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
    };
    return [...document.querySelectorAll(s)]
      .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && (e as HTMLElement).checkVisibility())
      .map((e) => ({ text: e.textContent!.trim().slice(0, 30), fg: getComputedStyle(e).color, bg: behind(e) }));
  }, sel);
  return found.map((m) => ({ ...m, ratio: contrast(hex(m.fg), hex(m.bg)), fg: hex(m.fg), bg: hex(m.bg) }));
}

async function below(page: Page, sel: string, min: number, label: string) {
  const r = await runs(page, sel);
  expect(r.length, `${label}: ${sel} has text`).toBeGreaterThan(0);
  return r.filter((m) => m.ratio < min).map((m) => `${label} ${sel} "${m.text}" ${m.fg} on ${m.bg} = ${m.ratio.toFixed(2)}:1`);
}

test('contrast_selected_rows_light_dark: text on the selected tree, Files, Search and Diff rows reads at 4.5:1', async ({ app, core }) => {
  const dir = core.project('files');
  for (const f of ['hello.ts', 'README.md']) fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/files', f), path.join(dir, f));
  for (const a of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  core.shell(dir, 'files'); // the Diff base is the commit at session start: change the file after it
  fs.appendFileSync(path.join(dir, 'hello.ts'), '// changed\n');
  openQuiet(core); // V2-9a: quiet projects start folded
  await openWindow(app, {}, core);
  const low: string[] = [];
  const check = async (surface: string, sel: string) => {
    for (const [mode, pick] of MODES) {
      await themed(app, mode, windowTokens(pick.colors));
      low.push(...(await below(app, sel, 4.5, `${mode} ${surface}`)));
    }
  };
  // The session tree: the project's head row is selected while its main session is open (name, "· main", chevron).
  await expect(app.locator('.row.head[aria-current="true"]')).toBeVisible();
  await check('tree', '.row.head[aria-current="true"] .chev, .row.head[aria-current="true"] b, .row.head[aria-current="true"] span');
  await app.getByRole('button', { name: 'Files', exact: true }).click();
  await app.locator('.frow[data-path="hello.ts"]').click();
  await expect(app.locator('.frow[aria-selected="true"]')).toBeVisible();
  await check('files', '.frow[aria-selected="true"] .chev, .frow[aria-selected="true"] .n, .frow[aria-selected="true"] .r');
  await app.getByRole('button', { name: 'Files', exact: true }).click();
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await app.getByRole('searchbox').fill('greeting');
  await app.getByRole('searchbox').press('Enter');
  await expect(app.locator('.hit[aria-selected="true"]')).toBeVisible();
  await check('search', '.hit[aria-selected="true"] .sln');
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await app.locator('.tab').first().click(); // back to the session: Diff reads the current session's folder
  await app.getByRole('button', { name: 'Diff', exact: true }).click();
  await app.getByRole('list', { name: 'Changed files' }).locator('[data-path]').first().click();
  await check('diff', '.diff .it[aria-pressed="true"], .diff .it[aria-pressed="true"] *');
  expect(low).toEqual([]);
});

test('contrast_diff_tinted_rows: Diff added and removed line numbers read at 4.5:1 on their row tints', async ({ app, core }) => {
  const dir = core.project('diff');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  core.shell(dir, 'diff');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n2\nthree\nfour\n');
  await openWindow(app, {}, core);
  await app.getByRole('button', { name: 'Diff', exact: true }).click();
  await app.getByRole('list', { name: 'Changed files' }).locator('[data-path]').first().click();
  await expect(app.locator('.diff .dl tr.add').first()).toBeVisible();
  await expect(app.locator('.diff .dl tr.del').first()).toBeVisible();
  const low: string[] = [];
  for (const [mode, pick] of MODES) {
    await themed(app, mode, windowTokens(pick.colors));
    for (const k of ['add', 'del']) low.push(...(await below(app, `.diff .dl tr.${k} td.n`, 4.5, `${mode} ${k}`)));
  }
  expect(low).toEqual([]);
});

/**
 * Keyboard focus on `loc`, so :focus-visible matches. Playwright's WebKit gives it to a script-focused button only
 * after some key presses and not at all in the layout-edit strip; there the test is skipped (the rule is plain CSS
 * and Chromium checks it; WebKit here is not WKWebView).
 */
async function keyFocus(page: Page, loc: Locator) {
  const visible = () => loc.evaluate((e) => e.matches(':focus-visible'));
  await loc.focus();
  await page.keyboard.press('Shift');
  if (!(await visible())) {
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await loc.focus();
  }
  test.skip(!(await visible()) && test.info().project.name === 'webkit', 'WebKit gives this button no :focus-visible from script');
  await expect(loc).toBeFocused();
  expect(await visible()).toBe(true);
}

/** Ancestors whose clip (overflow other than visible) cuts into the 4px band a 2px ring at a 2px offset occupies. */
const clippers = (btn: Locator) =>
  btn.evaluate((e) => {
    const b = e.getBoundingClientRect();
    const out: string[] = [];
    for (let n = e.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = n.getBoundingClientRect();
      const cut = [b.left - 4 < r.left + parseFloat(s.borderLeftWidth), b.right + 4 > r.right - parseFloat(s.borderRightWidth), b.top - 4 < r.top + parseFloat(s.borderTopWidth), b.bottom + 4 > r.bottom - parseFloat(s.borderBottomWidth)];
      if (cut.some(Boolean)) out.push(`${n.tagName.toLowerCase()}.${n.className}`);
    }
    return out;
  });

/** A `.btn.p` on a dialog surface: the Stop question's Stop button (the New session dialog it stood on is a popover now, v25-new-tab, needs 209). */
async function openNewSession(app: Page, core: Core) {
  core.agent(core.project('demo'), 'asks', 'never');
  await openWindow(app, {}, core);
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('dialog', { name: 'Command palette' }).locator('[data-command="session.stop"]').click();
  const btn = app.getByRole('alertdialog').getByRole('button', { name: 'Stop', exact: true });
  await expect(btn).toBeVisible();
  return btn;
}

test('primary_button_focus_ring_visible_all_themes: a focused .btn.p draws a 2px ring outside, 3:1 against its surface', async ({ app, core }) => {
  const btn = await openNewSession(app, core);
  const low: string[] = [];
  for (const t of BUILT_IN) {
    await app.evaluate((tk) => Object.entries(tk).forEach(([k, v]) => document.documentElement.style.setProperty(k, v)), windowTokens(t.colors));
    await keyFocus(app, btn);
    const m = await btn.evaluate((e) => {
      const s = getComputedStyle(e);
      let surface = '';
      for (let n = e.parentElement; n && !surface; n = n.parentElement) {
        const b = getComputedStyle(n).backgroundColor;
        if (!/rgba\(.*, 0\)$|transparent/.test(b)) surface = b;
      }
      return { w: s.outlineWidth, style: s.outlineStyle, offset: parseFloat(s.outlineOffset), ring: s.outlineColor, surface };
    });
    if (t === BUILT_IN[0]) expect(await clippers(btn), 'no ancestor clips the ring').toEqual([]);
    if (m.w !== '2px' || m.style !== 'solid' || !(m.offset > 0)) low.push(`${t.name}: outline ${m.w} ${m.style} offset ${m.offset}`);
    else if (contrast(hex(m.ring), hex(m.surface)) < 3) low.push(`${t.name}: ring ${hex(m.ring)} on ${hex(m.surface)} = ${contrast(hex(m.ring), hex(m.surface)).toFixed(2)}:1`);
  }
  expect(low).toEqual([]);
});

test('estrip_primary_focus_ring: in layout edit the focused Done button rings at 3:1 against the edit bar', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app, {}, core);
  await app.locator('nav[data-bar="right"] .lay').click();
  const btn = app.locator('.estrip .btn.p');
  await expect(btn).toBeVisible();
  const low: string[] = [];
  for (const t of BUILT_IN) {
    await app.evaluate((tk) => Object.entries(tk).forEach(([k, v]) => document.documentElement.style.setProperty(k, v)), windowTokens(t.colors));
    await keyFocus(app, btn);
    const m = await btn.evaluate((e) => {
      const s = getComputedStyle(e);
      return { w: s.outlineWidth, offset: parseFloat(s.outlineOffset), ring: s.outlineColor, strip: getComputedStyle(e.closest('.estrip')!).backgroundColor };
    });
    if (m.w !== '2px' || !(m.offset > 0)) low.push(`${t.name}: outline ${m.w} offset ${m.offset}`);
    else if (contrast(hex(m.ring), hex(m.strip)) < 3) low.push(`${t.name}: ring ${hex(m.ring)} on ${hex(m.strip)} = ${contrast(hex(m.ring), hex(m.strip)).toFixed(2)}:1`);
  }
  expect(low).toEqual([]);
});

test('primary_button_ring_moves_nothing: focusing and blurring a .btn.p leaves every box where it was', async ({ app, core }) => {
  const btn = await openNewSession(app, core);
  const boxes = () => app.evaluate(() => [...document.querySelectorAll('body *')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  await btn.evaluate((e) => (e as HTMLElement).blur());
  const before = await boxes();
  await keyFocus(app, btn);
  expect(await boxes()).toEqual(before);
  await btn.evaluate((e) => (e as HTMLElement).blur());
  expect(await boxes()).toEqual(before);
});

test('gallery_has_no_dev_note: the widget library shows no "v1b:" note and every text run reads at 4.5:1', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app, {}, core);
  await app.locator('nav[data-bar="right"] .lay').click();
  const gallery = app.getByRole('complementary', { name: 'Widget library' });
  await expect(gallery).toBeVisible();
  expect(await gallery.evaluate((e) => e.textContent)).not.toContain('v1b:');
  const low: string[] = [];
  for (const [mode, pick] of MODES) {
    await themed(app, mode, windowTokens(pick.colors));
    low.push(...(await below(app, '.lib, .lib *', 4.5, mode)));
  }
  expect(low).toEqual([]);
});

// Ticket 1052: a widened icon bar draws labels again; each (the open icon's on its tint too) reads at 4.5:1, light and dark.
test('rail_labels_contrast_1052: the labels of a widened bar read at 4.5:1 in both bundled themes', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await openWindow(app, {}, core);
  await app.locator('nav[data-bar="left"] [role="separator"]').focus();
  for (let i = 0; i < 7; i++) await app.keyboard.press('ArrowRight'); // 48 to 76 px: the full labels
  await expect(app.locator('nav[data-bar="left"]')).toHaveAttribute('data-compact', 'full');
  const low: string[] = [];
  for (const [mode, pick] of MODES) {
    await themed(app, mode, windowTokens(pick.colors));
    low.push(...(await below(app, '.ib .ai .al', 4.5, mode)));
  }
  expect(low).toEqual([]);
});
