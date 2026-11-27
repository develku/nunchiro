// Lane A of the designer panel (docs/design/v25-bug-sweep/panel.md, needs 149): a theme reaches the controls, not only
// the surfaces; no visible text is under 11px; text reads at 4.5:1 and control borders at 3:1, light and dark.
// The real-app half of theme_reaches_controls (pixels in the WKWebView) is scripts/app-click/repro.py theme.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { contrast, deriveTokens } from '../src/themes/derive';
import { parseGhostty } from '../src/themes/ghostty';
import { expect, openWindow, test, type Core } from './fixtures';
import { card, openTheme, rgb } from './theme-harness';

const MOCHA = deriveTokens(parseGhostty(THEMES['Catppuccin Mocha']));
const SYSTEM_BLUE = ['rgb(10, 132, 255)', 'rgb(0, 122, 255)', 'rgb(0, 103, 244)'];
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });

async function window(app: Page, core: Core) {
  const demo = core.project('demo');
  core.shell(demo, 'alpha');
  core.shell(demo, 'beta');
  await openWindow(app);
  await expect(app.locator('.tree').first()).toBeVisible();
}

async function settingsPages(app: Page) {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(nav(app)).toBeVisible();
  return nav(app).getByRole('button').allInnerTexts();
}

test('theme_reaches_controls: with Catppuccin Mocha picked, the radio, selected nav bar, Undo button and selected card take the theme, none system blue', async ({ app, core }) => {
  await window(app, core);
  await openTheme(app);
  await card(app, 'Catppuccin Mocha').locator('.tpick').click(); // D-20261108-12: a click applies, no Keep step
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  // The undo line's button: its colours are the theme's own (no Keep button any more).
  const undo = app.locator('footer.status .undoline').getByRole('button', { name: /^Undo/ });
  const k = await undo.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color, line: getComputedStyle(e).borderTopColor }));
  for (const v of Object.values(k)) for (const b of SYSTEM_BLUE) expect(v).not.toContain(b);
  expect(k.fg).toBe(rgb(MOCHA['--text']));
  const accent = rgb(MOCHA['--run']);
  expect(accent).not.toBe(rgb('#4493f8')); // the theme's own blue, not the ko/ status hue
  const got = await app.evaluate(() => {
    const css = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    // Ticket 1041 lane 8 (owner 15.1 item 1, 11-22): Settings' controls are neutral, so the theme reaches them as its ink
    // (the control colour) and its select step, no longer as its accent.
    const probe = document.createElement('i');
    probe.style.background = 'var(--select-bg)';
    document.querySelector('.settings[role="region"]')!.append(probe);
    const select = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      radio: css('.settings[role="region"] input[type=radio]').accentColor,
      nav: css('.settings nav button[aria-current="page"]').backgroundColor,
      card: css('.tpick[aria-pressed="true"]').backgroundColor,
      select,
      focus: getComputedStyle(document.documentElement).getPropertyValue('--focus-ring').trim(),
    };
  });
  expect(got.radio).toBe(rgb(MOCHA['--text']));
  expect(got.nav).toBe(got.select);
  expect(got.card).toBe(got.select);
  expect(got.select).not.toBe('rgba(0, 0, 0, 0)');
  for (const v of Object.values(got)) for (const b of SYSTEM_BLUE) expect(v).not.toContain(b);
});

/** Every visible text run under 11px, as "selector text size". The theme cards' mini windows are drawn samples. */
const smallText = (app: Page) =>
  app.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const e = n.parentElement;
      if (!e || !n.textContent?.trim() || e.closest('.tw, .xterm, .sr, script, style, [hidden]')) continue;
      if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !e.getClientRects().length) continue;
      const size = parseFloat(getComputedStyle(e).fontSize);
      if (size < 11) out.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${n.textContent.trim().slice(0, 20)}" ${size}px`);
    }
    return [...new Set(out)];
  });

test('no_text_under_11px: every visible text run on the main window, tree and each Settings page is at least 11px', async ({ app, core }) => {
  await window(app, core);
  const found = (await smallText(app)).map((s) => `main: ${s}`);
  for (const page of await settingsPages(app)) {
    await nav(app).getByRole('button', { name: page, exact: true }).click();
    await app.waitForTimeout(150); // lazy pages (Theme's catalog) settle
    found.push(...(await smallText(app)).map((s) => `${page}: ${s}`));
  }
  expect(found).toEqual([]);
});

/** Control borders (buttons, fields) under 3:1 against the surface they sit on. */
const weakBorders = (app: Page) =>
  app.evaluate(() => {
    const px = (c: string) => c.match(/[\d.]+/g)!.map(Number);
    const lum = (c: string) => {
      const [r, g, b] = px(c).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const behind = (e: Element | null) => {
      for (; e; e = e.parentElement) {
        const b = getComputedStyle(e).backgroundColor;
        if (!/rgba\(.*, 0\)$|transparent/.test(b)) return b;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const out: string[] = [];
    for (const e of document.querySelectorAll('.btn, input:not([type=radio]):not([type=checkbox]):not([type=range]), select, textarea')) {
      const s = getComputedStyle(e);
      // A fully transparent border is no border, like style none: the ghost link buttons (Agents' agents.toml, Accounts' prv-ghost)
      // keep one only for size. px() would read rgba(0, 0, 0, 0) as black (21:1 on light, 1.11:1 on dark).
      const clear = /rgba\(.*, 0\)$|transparent/.test(s.borderTopColor);
      if (!e.checkVisibility() || clear || s.borderTopStyle === 'none' || parseFloat(s.borderTopWidth) === 0 || (e as HTMLButtonElement).disabled) continue;
      // A filled control is told apart by its fill; its border only matters when the fill matches the surface.
      const bg = behind(e.parentElement);
      const fill = s.backgroundColor;
      if (!/rgba\(.*, 0\)$|transparent/.test(fill) && ratio(fill, bg) >= 3) continue;
      const r = ratio(s.borderTopColor, bg);
      if (r < 3) out.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${s.borderTopColor} on ${bg} = ${r.toFixed(2)}`);
    }
    return [...new Set(out)];
  });

const axeContrast = async (app: Page, sel: string) => {
  const r = await new AxeBuilder({ page: app }).include(sel).exclude('.tw').withRules(['color-contrast']).analyze();
  return r.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any[0]?.message ?? v.id}`));
};

test('contrast_aa: text reads at 4.5:1 and control borders at 3:1 on the main window, tree and Settings, light and dark', async ({ app, core }) => {
  test.setTimeout(180_000);
  await window(app, core);
  const found: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    found.push(...(await axeContrast(app, 'body')).map((s) => `${scheme} main: ${s}`));
    found.push(...(await weakBorders(app)).map((s) => `${scheme} main: ${s}`));
    for (const page of await settingsPages(app)) {
      await nav(app).getByRole('button', { name: page, exact: true }).click();
      await app.waitForTimeout(150);
      found.push(...(await axeContrast(app, '.settings')).map((s) => `${scheme} ${page}: ${s}`));
      found.push(...(await weakBorders(app)).map((s) => `${scheme} ${page}: ${s}`));
    }
    await app.keyboard.press('Escape');
    await app.locator('.tab:not([data-tab="settings"])').first().click();
  }
  expect(found).toEqual([]);
});

test('accent_contrast_every_theme: the derived accent (--run) reads at 3:1 on every surface of every built-in theme', () => {
  const low: string[] = [];
  for (const [name, text] of Object.entries(THEMES)) {
    const t = deriveTokens(parseGhostty(text));
    // --hover is a tint (#rrggbbaa) since the design book: it is measured as painted on --page.
    const a = parseInt(t['--hover'].slice(7, 9) || 'ff', 16) / 255;
    const hover = `#${[1, 3, 5].map((i) => Math.round(parseInt(t['--page'].slice(i, i + 2), 16) * (1 - a) + parseInt(t['--hover'].slice(i, i + 2), 16) * a).toString(16).padStart(2, '0')).join('')}`;
    const on: Record<string, string> = { '--page': t['--page'], '--panel': t['--panel'], '--hover': hover };
    for (const [s, bg] of Object.entries(on)) if (contrast(t['--run'], bg) < 3) low.push(`${name} --run on ${s}`);
  }
  expect(low).toEqual([]);
});

/** Visible controls whose box is under 24x24 CSS px (WCAG 2.5.8 target size), as "selector name w x h". */
const smallTargets = (app: Page) =>
  app.evaluate(() => {
    const out: string[] = [];
    for (const e of document.querySelectorAll('button, [role=button], a[href], input, select, summary, [role=tab], [role=menuitem]')) {
      if (e.closest('.tw, .xterm, [inert]') || !(e as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if ((e as HTMLInputElement).type === 'hidden' || (e as HTMLButtonElement).disabled) continue;
      // Steppers beside a typed number field: the field is the equivalent control (WCAG 2.5.8 "Equivalent").
      if (e.closest('.numf .steps')) continue;
      // A check or radio inside its label: the label is the target.
      const box = /^(checkbox|radio)$/.test((e as HTMLInputElement).type) ? (e.closest('label') ?? e) : e;
      const r = box.getBoundingClientRect();
      // The ::after hit box some icon buttons draw counts: its inset widens the target without moving layout.
      const a = getComputedStyle(e, '::after');
      const grow = a.content !== 'none' && a.position === 'absolute' ? Math.max(0, -parseFloat(a.left) || 0) * 2 : 0;
      const w = r.width + grow;
      const h = r.height + (a.content !== 'none' && a.position === 'absolute' ? Math.max(0, -parseFloat(a.top) || 0) * 2 : 0);
      if (r.width && r.height && (w < 24 || h < 24))
        out.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 18)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return [...new Set(out)];
  });

test('hit_targets_24: every visible control on the main window, tree and each Settings page is at least 24x24', async ({ app, core }) => {
  test.setTimeout(120_000);
  await window(app, core);
  const found = (await smallTargets(app)).map((s) => `main: ${s}`);
  for (const page of await settingsPages(app)) {
    await nav(app).getByRole('button', { name: page, exact: true }).click();
    await app.waitForTimeout(150);
    found.push(...(await smallTargets(app)).map((s) => `${page}: ${s}`));
  }
  expect(found).toEqual([]);
});

test('focus_ring_outside: Tab through the window and Settings > Appearance; each focused control draws its 2px ring outside', async ({ app, core, browserName }) => {
  await window(app, core);
  await settingsPages(app);
  await nav(app).getByRole('button', { name: 'Appearance', exact: true }).click();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons, as Safari's does
  const seen: string[] = [];
  const inside: string[] = [];
  // The pane zone (.lz) and the ko/ tree rows (.row, inset box-shadow) keep their ring inside on purpose.
  for (let i = 0; i < 60; i++) {
    await app.keyboard.press(tab);
    const f = await app.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e || e === document.body || e.closest('.lz, .row, .xterm')) return null;
      const s = getComputedStyle(e);
      return { name: `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 18)}"`, style: s.outlineStyle, width: s.outlineWidth, offset: parseFloat(s.outlineOffset) };
    });
    if (!f) continue;
    seen.push(f.name);
    if (f.style === 'none' || f.width !== '2px' || f.offset < 0) inside.push(`${f.name} ${f.style} ${f.width} offset ${f.offset}`);
  }
  expect(new Set(seen).size).toBeGreaterThan(10);
  expect([...new Set(inside)]).toEqual([]);
});

test('focus_ring_on_you_rows: the ring reads at 3:1 on the your-turn tint in Nunchiro Light/Dark and every built-in theme', () => {
  const low: string[] = [];
  const ko = { light: ['#0969da', '#fff1e5'], dark: ['#4493f8', '#3a2614'] };
  for (const [name, [ring, bg]] of Object.entries(ko)) if (contrast(ring, bg) < 3) low.push(`Nunchiro ${name}`);
  for (const [name, text] of Object.entries(THEMES)) {
    const t = deriveTokens(parseGhostty(text));
    if (contrast(t['--run'], t['--you-bg']) < 3) low.push(name);
  }
  expect(low).toEqual([]);
});
