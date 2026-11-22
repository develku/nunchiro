// Ticket V1A-63: file explorer icons. The lookup is a pure function (no page); the rest runs the real window on the
// Files fixtures (see fixtures/files/harness.ts).
import fs from 'node:fs';
import path from 'node:path';
import { expect as plainExpect, test as plain } from '@playwright/test';
import { EXTENSIONS, iconFor, NAMES } from '../src/files/icons';
import { SYMBOLS } from '../src/files/sprite';
import { contrast } from '../src/themes/derive';
import { windowTokens } from './window-tokens';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, test } from './fixtures';
import { setup } from './fixtures/files/harness';

plain('file-icon-mapping: exact names, then extensions (case-insensitive), then folder, then the default file', () => {
  // Exact names beat extensions.
  plainExpect(iconFor('Cargo.toml', 'file')).toBe('rust');
  plainExpect(iconFor('other.toml', 'file')).toBe('settings');
  plainExpect(iconFor('package.json', 'file')).toBe('npm');
  plainExpect(iconFor('data.json', 'file')).toBe('json');
  plainExpect(iconFor('Dockerfile', 'file')).toBe('docker');
  plainExpect(iconFor('README.md', 'file')).toBe('readme');
  plainExpect(iconFor('notes.md', 'file')).toBe('markdown');
  plainExpect(iconFor('.gitignore', 'file')).toBe('git');
  plainExpect(iconFor('LICENSE', 'file')).toBe('license');
  plainExpect(iconFor('Makefile', 'file')).toBe('makefile');
  // Extensions: the last dot, any case; double extensions only when listed (none are).
  plainExpect(iconFor('main.rs', 'file')).toBe('rust');
  plainExpect(iconFor('PHOTO.JPG', 'file')).toBe('image');
  plainExpect(iconFor('App.Tsx', 'file')).toBe('react');
  plainExpect(iconFor('types.d.ts', 'file')).toBe('typescript');
  plainExpect(iconFor('archive.tar.gz', 'file')).toBe('zip');
  // Unknown extension, no dot, a dotfile with no listed name, a trailing dot: the default file.
  plainExpect(iconFor('data.xyz123', 'file')).toBe('file');
  plainExpect(iconFor('NOTES', 'file')).toBe('file');
  plainExpect(iconFor('.prettierrc', 'file')).toBe('file');
  plainExpect(iconFor('odd.', 'file')).toBe('file');
  // Names that are Object.prototype keys are ordinary unknown files.
  for (const n of ['constructor', '__proto__', 'toString', 'a.constructor', 'x.hasOwnProperty']) plainExpect(iconFor(n, 'file'), n).toBe('file');
  // Folders by state, whatever the name; a symlink is looked up by its name.
  plainExpect(iconFor('src', 'dir')).toBe('folder');
  plainExpect(iconFor('src', 'dir', true)).toBe('folder-open');
  plainExpect(iconFor('node_modules.json', 'dir')).toBe('folder');
  plainExpect(iconFor('link.rs', 'symlink')).toBe('rust');
  // Every icon the table names is a symbol in the sprite.
  const ids = new Set([...SYMBOLS.matchAll(/<symbol id="fi-([a-z-]+)"/g)].map((m) => m[1]));
  const named = new Set([...Object.values(NAMES), ...Object.values(EXTENSIONS), 'file', 'folder', 'folder-open']);
  plainExpect([...named].filter((n) => !ids.has(n))).toEqual([]);
  plainExpect(ids.size).toBeGreaterThanOrEqual(35);
});

test('file-icon-folder-state: closed folder, open on expand, closed again on collapse', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => (fs.mkdirSync(path.join(d, 'src')), fs.writeFileSync(path.join(d, 'src/main.rs'), '')) });
  const r = (p: string) => app.locator(`.frow[data-path="${p}"]`);
  const use = (p: string) => r(p).locator('svg.fi use');
  await expect(use('src')).toHaveAttribute('href', '#fi-folder');
  await expect(use('hello.ts')).toHaveAttribute('href', '#fi-typescript');
  await r('src').click();
  await expect(r('src')).toHaveAttribute('aria-expanded', 'true');
  await expect(use('src')).toHaveAttribute('href', '#fi-folder-open');
  await expect(use('src/main.rs')).toHaveAttribute('href', '#fi-rust');
  await r('src').click();
  await expect(r('src')).toHaveAttribute('aria-expanded', 'false');
  await expect(use('src')).toHaveAttribute('href', '#fi-folder');
});

test('file-icon-a11y: icons are hidden from assistive tech and not focusable; row names stay the file name', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => fs.mkdirSync(path.join(d, 'src')) });
  const icons = app.locator('.frow svg.fi');
  await expect(icons.first()).toBeAttached();
  const attrs = await icons.evaluateAll((els) => els.map((e) => [e.getAttribute('aria-hidden'), e.getAttribute('focusable'), e.getAttribute('tabindex')]));
  expect(attrs.length).toBe(await app.locator('.frow').count());
  for (const a of attrs) expect(a).toEqual(['true', 'false', null]);
  for (const name of ['hello.ts', 'README.md', 'src']) await expect(app.getByRole('treeitem', { name, exact: true })).toBeVisible();
});

test('file-icon-sprite-once: one sprite, rows stay virtualised and no icon is fetched', async ({ app, core }) => {
  const asked: string[] = [];
  app.on('request', (r) => asked.push(r.url()));
  await setup(app, core, {
    extra: (d) => {
      fs.mkdirSync(path.join(d, 'many'));
      for (let i = 0; i < 10_000; i++) fs.writeFileSync(path.join(d, 'many', `f${String(i).padStart(5, '0')}.rs`), '');
    },
  });
  const mark = asked.length;
  await app.locator('.frow[data-path="many"]').click();
  await expect(app.locator('.frow[data-path="many/f00000.rs"] svg.fi use')).toHaveAttribute('href', '#fi-rust');
  await app.evaluate(() => {
    const t = document.querySelector('.ftree')!;
    t.scrollTop = t.scrollHeight;
  });
  await expect(app.locator('.frow[data-path="many/f09999.rs"]')).toBeVisible();
  expect(await app.locator('#file-icons').count()).toBe(1);
  expect(await app.locator('symbol[id^="fi-"]').evaluateAll((s) => s.length)).toBeGreaterThanOrEqual(35);
  // Same bound as files.spec's 10,000-entry case.
  expect(await app.locator('.frow').count()).toBeLessThan(120);
  expect(asked.slice(mark).filter((u) => /\.svg|icon|font|woff/i.test(u))).toEqual([]);
  // Every row's icon resolves to a symbol in the sprite.
  const missing = await app.locator('.frow svg.fi use').evaluateAll((us) => us.map((u) => u.getAttribute('href')!).filter((h) => !document.querySelector(h)));
  expect(missing).toEqual([]);
});

// Ticket 293 (needs 212): catalog themes are applied as written, with no contrast push, so only the bundled pair (tokens.css) promises these ratios.
const BUILT_IN = [LIGHT_PICK, DARK_PICK];

test('file-icon-contrast: icons reach 3:1 on the row background in every built-in theme, light and dark', async ({ app, core }) => {
  await setup(app, core, { extra: (d) => (fs.mkdirSync(path.join(d, 'src')), fs.writeFileSync(path.join(d, 'src/x.rs'), '')) });
  await app.locator('.frow[data-path="src"]').click();
  await expect(app.locator('.frow[data-path="src/x.rs"]')).toBeVisible();
  // One row selected (open file tab marks it), one hovered: the surfaces an icon sits on.
  await app.locator('.frow[data-path="hello.ts"]').click();
  await expect(app.locator('.frow[data-path="hello.ts"]')).toHaveAttribute('aria-selected', 'true');
  await app.locator('.frow[data-path="README.md"]').hover();
  const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  const low: string[] = [];
  const seen = new Set<string>();
  for (const t of BUILT_IN) {
    const measured = await app.evaluate((tokens) => {
      for (const [k, v] of Object.entries(tokens)) document.documentElement.style.setProperty(k, v);
      // Since ticket 1041 lane 7b (59504f746) hover and selection are translucent tints (--tint-1, --tint-2): blend each layer over
      // the one behind it down to an opaque one, as the screen shows it.
      const rgba = (c: string) => {
        const n = (c.match(/[\d.]+/g) ?? []).map(Number);
        const srgb = c.startsWith('color(');
        return { rgb: n.slice(0, 3).map((v) => (srgb ? v * 255 : v)), a: n.length > 3 ? n[3] : 1 };
      };
      const behind = (e: Element | null): string => {
        const layers: { rgb: number[]; a: number }[] = [];
        for (; e; e = e.parentElement) {
          const l = rgba(getComputedStyle(e).backgroundColor);
          if (l.a > 0) layers.push(l);
          if (l.a >= 1) break;
        }
        if (!layers.length || layers[layers.length - 1].a < 1) layers.push(rgba(getComputedStyle(document.body).backgroundColor), { rgb: [255, 255, 255], a: 1 });
        const out = layers.reduceRight((under, l) => under.map((u, i) => l.rgb[i] * l.a + u * (1 - l.a)), [255, 255, 255]);
        return `rgb(${out.map(Math.round).join(', ')})`;
      };
      return [...document.querySelectorAll('.frow svg.fi')].map((e) => ({
        path: (e.parentElement as HTMLElement).dataset.path!,
        fg: getComputedStyle(e).fill,
        bg: behind(e.parentElement),
      }));
    }, windowTokens(t.colors));
    expect(measured.length, t.name).toBeGreaterThan(3);
    seen.add(contrast('#ffffff', t.colors.background) > contrast('#000000', t.colors.background) ? 'dark' : 'light');
    for (const m of measured) {
      const ratio = contrast(hex(m.fg), hex(m.bg));
      if (ratio < 3) low.push(`${t.name} ${m.path}: ${hex(m.fg)} on ${hex(m.bg)} = ${ratio.toFixed(2)}:1`);
    }
  }
  expect([...seen].sort()).toEqual(['dark', 'light']);
  expect(low).toEqual([]);
});
