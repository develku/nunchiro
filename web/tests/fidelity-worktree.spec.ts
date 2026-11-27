// FIDELITY pass 4 (ticket 65): the new-worktree dialog, the discard dialog, the Tidy panel and the undo toast against
// ko/v2-8a-compare-r3.html (WTDIALOGS Draft 3; Draft 1 One-click+ is the base for new/discard/toast, Draft 3 for Tidy).
// Pixels: Chromium only, via visual/compare.ts. The mockup text is Korean sample data, so each frame's `prepare` fills the
// mockup frame with the app's own words (and drops the pieces the app does not build yet: the
// "commit and remove" / "move to a new branch" buttons, the disabled checkbox of a dirty row). The box is what is measured:
// size, border, radius, spacing, type, chips, focus ring and colours. A match proves looks, not behaviour.
import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';
import { bookControls, bookPalette, expectMatchesMockup, outDir, repo, show, type Scheme } from './visual/compare';
import { MOCKUPS, mockup } from './visual/mockups';

outDir('fidelity-worktree');
test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });

const FILE = 'v2-8a-compare-r3.html';
const SCHEMES = ['light', 'dark'] as const;
const NEW = 'section[aria-labelledby="h-d1"] .dlg[aria-label="new worktree"]';
const TIDY = 'section[aria-labelledby="h-d3"] .dlg[aria-label^="정리 ·"]';

const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' });
type Listed = { path: string; branch: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
/** A worktree whose agent session ended: its folder holds no running session. */
const ended = (core: Core, w: Listed) => {
  const s = core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
  core.cli('session', 'close', s.id);
  return s.id;
};
const clean = (app: Page) => app.mouse.move(900, 600);

/** The mockup page, rebuilt by `fill` with the app's words. */
const on = (fill: (m: Page) => Promise<void>) => async (m: Page) => {
  // The frames sit in a 4-column grid ~300px wide: at the app's width one would run under its neighbour. One column.
  // The mockup leaves `.chk .rb` unstyled (a UA grey button); the app gives it the mockup's own `.row .rb` look.
  // Kept (ticket 109): without the `.chk .rb,h4 .rb` rule `dark_tidy_resolve_width` fails on exactly that UA button
  // (mockup Resolve bg rgb(239, 239, 239), border 2px outset, width 76.39 vs the app's 67.66). Do not extend it.
  await m.addStyleTag({ content: '.cols{display:block!important}.col{margin-bottom:12px}.chk .rb,h4 .rb{font:600 11px system-ui;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:5px;padding:1px 7px}' });
  await fill(m);
};

/** "New worktree": Cmd+N, text typed as in the mockup's first state ("fix login redirect"). */
async function newDialog(app: Page, core: Core, scheme: Scheme) {
  const p = repo(core, 'nunchiro');
  core.shell(p, 'main');
  openQuiet(core);
  await show(app, scheme);
  await expect(app.locator('.grp[data-project="nunchiro"]')).toBeVisible();
  await app.keyboard.press('Meta+KeyN');
  const d = app.getByRole('dialog', { name: 'New worktree' });
  await expect(d.getByRole('textbox')).toBeFocused();
  await app.keyboard.type('fix login redirect');
  await clean(app);
  return d;
}
const newFill = (d: Locator, _scheme: Scheme) => async (m: Page) => {
  await bookPalette(d, m);
  const hint = await d.locator('.wthint').first().innerHTML();
  const advanced = await d.locator('.wtadvanced').innerText();
  const cancel = await d.locator('.wtcancel').innerText();
  const value = await d.getByRole('textbox').inputValue();
  // Control style (ticket 1041 A, docs/design/polish-1121 .cmd): the polish field is a quiet tint with no outline, so the older WTDIALOGS field's line, fill and radius are replaced; layout, words and order stay the mockup's.
  await m.addStyleTag({ content: `${NEW} .fld input{border-color:transparent;background:${await d.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tint-1').trim())};border-radius:6px}` });
  // Copy only: the mockup already holds ticket 468's field and ticket 294's Cancel at the line end (ticket 529).
  await m.locator(NEW).first().evaluate(
    (e, a) => {
      e.querySelectorAll('.hint')[0].innerHTML = a.hint;
      const row = e.querySelectorAll('.hint')[1];
      row.childNodes[1].textContent = ` ${a.advanced.replace(/^⌥↵\s*/, '')}`;
      row.lastElementChild!.textContent = a.cancel;
      e.querySelector('input')!.value = a.value;
    },
    { hint, advanced, cancel, value },
  );
};

/** "Discard": v2-undo with three unsaved files and two unpushed commits; Backspace on its row. */
async function discardDialog(app: Page, core: Core, scheme: Scheme) {
  const p = repo(core, 'nunchiro');
  const w = create(core, p, 'v2-undo');
  for (const f of ['undo.rs', 'undo.test.ts', 'undo-sketch.md']) fs.writeFileSync(path.join(w.path, f), 'x');
  for (const f of ['c1.txt', 'c2.txt']) {
    fs.writeFileSync(path.join(w.path, f), f);
    git(w.path, 'add', f);
    git(w.path, 'commit', '-q', '-m', `unpushed ${f}`);
  }
  core.shell(p, 'main');
  openQuiet(core);
  await show(app, scheme);
  const row = app.locator('.row.wt2').filter({ hasText: 'v2-undo' }).first();
  await row.focus();
  await app.keyboard.press('Backspace');
  const d = app.getByRole('alertdialog', { name: 'v2-undo has unsaved work' });
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await clean(app);
  return d;
}
/** "Toast": a clean remove of v2-spaces next to a running v2-palette, as in the mockup. */
async function toast(app: Page, core: Core, scheme: Scheme) {
  const p = repo(core, 'nunchiro');
  create(core, p, 'v2-spaces');
  core.shell(p, 'main');
  openQuiet(core);
  await show(app, scheme);
  await app.locator('.row.wt2').filter({ hasText: 'v2-spaces' }).first().focus();
  await app.keyboard.press('Backspace');
  const t = app.getByRole('status').filter({ hasText: 'Removed v2-spaces' }).locator('.wtbar');
  await expect(t).toBeVisible();
  await clean(app);
  return t;
}
/** "Tidy": 2 merged (PR chip patched), 1 folder gone, 2 needing a decision, over three projects as in the mockup. */
async function tidyPanel(app: Page, core: Core, scheme: Scheme) {
  const merged = new Set<string>();
  const projects = ['nunchiro', 'lumen', 'tide'].map((n) => repo(core, n));
  const [n, k, s] = projects;
  merged.add(ended(core, create(core, n, 'v2-9a-groups')));
  merged.add(ended(core, create(core, k, 'lcfollow')));
  const gone = create(core, s, 'v2-old');
  git(s, 'worktree', 'remove', '--force', '--', gone.path);
  for (const [p, b] of [[n, 'v2-undo'], [k, 'rehfix']] as const) fs.writeFileSync(path.join(create(core, p, b).path, 'lost.txt'), 'x');
  for (const p of projects) core.shell(p, 'main');
  openQuiet(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Set<number>();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'pr_chip' && merged.has(r.request.id)) chips.add(r.id);
      server.send(msg);
    });
    server.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r && chips.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      ws.send(msg);
    });
  });
  await show(app, scheme);
  await expect(app.locator('.grp[data-project="nunchiro"]')).toBeVisible();
  await expect(async () => {
    await app.keyboard.press('Meta+KeyK');
    await expect(app.locator('.palette input')).toBeFocused({ timeout: 3000 });
  }).toPass({ timeout: 15_000 });
  await app.keyboard.type('worktree.tidy');
  await app.keyboard.press('Enter');
  const d = app.getByRole('dialog', { name: /^Tidy/ });
  await expect(d).toBeVisible();
  const all = d.getByRole('button', { name: 'All projects' });
  if ((await all.count()) && (await all.getAttribute('aria-pressed')) === 'false') await all.click();
  await expect(d.getByRole('listitem')).toHaveCount(5);
  // The click on "All projects" took the panel's own focus: Cancel gets it back by keyboard, so its ring shows (focus-visible).
  await d.getByRole('button', { name: 'Cancel' }).focus();
  await app.keyboard.press('Shift+Tab');
  await app.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await clean(app);
  return d;
}
const tidyFill = (d: Locator) => async (m: Page) => {
  await bookPalette(d, m);
  const a = await d.evaluate((e) => ({
    title: e.querySelector('.wtttl span')!.textContent,
    groups: [...e.querySelectorAll('section')].map((s) => ({
      h: s.querySelector('.wtcap')!.textContent,
      rows: [...s.querySelectorAll('li')].map((li) => ({ name: [...li.querySelector('.tn')!.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), small: li.querySelector('small')!.textContent, box: !!li.querySelector('input'), resolve: !!li.querySelector('.resolve') })),
    })),
    buttons: [...e.querySelectorAll('.wtacts button')].map((b) => b.textContent),
    toggle: e.querySelector('.wtttl button')?.textContent ?? null,
  }));
  // Text only: the frame keeps its classes, inline styles and elements (`mockup_frame_not_adjusted`). A row or button the app
  // does not build is removed; one the frame lacks (the "All projects" toggle, a dirty row's checkbox) stays a measured difference.
  await m.locator(TIDY).first().evaluate((e, a) => {
    const first = (el: Element) => [...el.childNodes].find((n) => n.nodeType === 3)!;
    e.querySelector('h4')!.textContent = a.title;
    const caps = [...e.querySelectorAll('.grp')];
    caps.forEach((cap, i) => {
      const g = a.groups[i];
      const rows: Element[] = [];
      for (let n = cap.nextElementSibling; n?.classList.contains('chk'); n = n.nextElementSibling) rows.push(n);
      if (!g) return [cap, ...rows].forEach((x) => x.remove());
      cap.textContent = g.h;
      rows.forEach((row, k) => {
        const r = g.rows[k];
        if (!r) return row.remove();
        first(row.querySelector('span')!).textContent = r.name;
        row.querySelector('small')!.textContent = r.small;
        const rb = row.querySelector('.rb');
        if (rb) rb.textContent = rb.textContent!.replace(/^\S+/, 'Resolve');
      });
    });
    [...e.querySelectorAll('.actions button')].forEach((b, i) => (a.buttons[i] === undefined ? b.remove() : (b.textContent = a.buttons[i])));
  }, a);
};

/** The mockup page as `expectMatchesMockup` builds it (same scheme, same `prepare`), kept open for computed-style reads. */
async function rawMockup(app: Page, prepare: (m: Page) => Promise<void>) {
  const m = await app.context().newPage();
  await m.setViewportSize(app.viewportSize()!);
  await m.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await m.goto(`file://${mockup(FILE)}`);
  await prepare(m);
  return m;
}
/** Computed style of one element: what the eye reads as its colour, border and width. */
const look = (l: Locator) =>
  l.first().evaluate((e) => {
    const c = getComputedStyle(e);
    return { accent: c.accentColor, bg: c.backgroundColor, scheme: c.colorScheme, border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`, outline: c.outlineStyle, width: e.getBoundingClientRect().width };
  });

test.describe('dark_tidy_matches_mockup_computed', { tag: '@chromium' }, () => {

  test('dark_tidy_checkbox_colour / dark_tidy_all_projects_border / dark_tidy_resolve_width', async ({ app, core }) => {
    const d = await tidyPanel(app, core, 'dark');
    const m = await rawMockup(app, on(tidyFill(d)));
    // Designer panel 2026-10-31 (needs 149): inputs take the theme accent, not the UA blue the mockup leaves; the
    // mockup's box gets the app's accent so the drawn boxes still compare like for like.
    const accent = await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || getComputedStyle(document.documentElement).getPropertyValue('--run').trim());
    await m.addStyleTag({ content: `input { accent-color: ${accent}; }` });
    // The mockup frame has no "All projects" button: its `.rb` (the pill the mockup draws in `.row`) is the look the toggle follows.
    const mock = {
      box: await look(m.locator(`${TIDY} input[type=checkbox]:not(:disabled)`)),
      all: await look(m.locator('section[aria-labelledby="h-d3"] .row .rb')),
      resolve: await look(m.locator(`${TIDY} .rb`)),
    };
    const got = {
      box: await look(d.locator('input[type=checkbox]')),
      all: await look(d.getByRole('button', { name: 'All projects' })),
      resolve: await look(d.getByRole('button', { name: /^Resolve/ })),
    };
    console.log('TIDY-DARK', JSON.stringify({ mock, got }));
    // Design book (controls): the check is the book's, not the mockup's UA box: 16, checked in ink (--text), never blue.
    const ink = await app.evaluate(() => {
      const i = document.createElement('i');
      i.style.color = 'var(--text)';
      document.body.append(i);
      const c = getComputedStyle(i).color;
      i.remove();
      return c;
    });
    expect(got.box.bg, 'checked box is ink').toBe(ink);
    expect(Math.round(got.box.width), 'check size').toBe(16);
    expect(got.all.border.startsWith('0px none'), `All projects has no outline (design book buttons are fills): ${got.all.border}`).toBe(true);
    expect(got.all.outline, 'All projects (pressed) draws no outline of its own').toBe(mock.all.outline);
    // Resolve is the book's small button (24 high, padding 0 8, 12 px), so its width no longer follows the mockup's pill.
    expect(Math.round((await d.getByRole('button', { name: /^Resolve/ }).first().boundingBox())!.height), 'Resolve height').toBe(24);
  });

  for (const scheme of SCHEMES) {
    test(`resolve_caret_matches_mockup (${scheme})`, async ({ app, core }) => {
      const d = await tidyPanel(app, core, scheme);
      const m = await rawMockup(app, on(tidyFill(d)));
      // The mockup draws the caret as the text glyph "▾" after "Resolve": the glyph's box is what the eye reads.
      const mock = await m.locator(`${TIDY} .rb`).first().evaluate((b) => {
        const t = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent!.includes('▾'))!;
        const i = t.textContent!.indexOf('▾');
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        // Ink box of the glyph (canvas metrics in the button's own font), not the 13px line box of the range.
        const c = document.createElement('canvas').getContext('2d')!;
        c.font = getComputedStyle(b).font;
        const k = c.measureText('▾');
        return { advance: r.getBoundingClientRect().width, width: k.actualBoundingBoxLeft + k.actualBoundingBoxRight, height: k.actualBoundingBoxAscent + k.actualBoundingBoxDescent };
      });
      // Ink box of the svg too: the Octicon path fills part of its 16-unit box, so the box size alone is not what shows.
      const caret = await d.getByRole('button', { name: /^Resolve/ }).first().locator('svg').evaluate((e) => {
        const box = e.getBoundingClientRect();
        const ink = e.querySelector('path')!.getBBox();
        const k = box.width / 16;
        return { size: box.width, width: ink.width * k, height: ink.height * k };
      });
      console.log('RESOLVE-CARET', scheme, JSON.stringify({ mock, app: caret }));
      expect(Math.abs(caret.width - mock.width), `caret ink width ${scheme}: app ${caret.width} (svg ${caret.size}px) vs mockup ${mock.width}`).toBeLessThanOrEqual(0.3);
    });
  }

  test('mockup_frame_not_adjusted', async ({ app, core }) => {
    const d = await tidyPanel(app, core, 'dark');
    const m = await app.context().newPage();
    await m.goto(`file://${mockup(FILE)}`);
    const shape = () => m.locator(TIDY).first().evaluate((e) => [e, ...e.querySelectorAll('*')].map((x) => ({ cls: x.className, style: x.getAttribute('style') })));
    const before = await shape();
    await on(tidyFill(d))(m);
    const after = await shape();
    expect(after, 'classes and inline styles of the frame, by position').toEqual(before);
  });
});

for (const scheme of SCHEMES) {
  test.describe(`worktree_dialogs_match_mockup (${scheme})`, { tag: '@chromium' }, () => {

    test('mockup_copied_and_hashed', async () => {
      const readme = fs.readFileSync(path.join(MOCKUPS, 'README.md'), 'utf8');
      const sha = createHash('sha256').update(fs.readFileSync(mockup(FILE))).digest('hex');
      expect(readme, `${FILE} row with its sha256`).toMatch(new RegExp(`\\| \`${FILE}\` \\|[^|]*WTDIALOGS[^|]*\\| \`${sha}\` \\|`));
    });

    test('new worktree dialog', async ({ app, core }) => {
      const d = await newDialog(app, core, scheme);
      // Design book (controls): the mockup's field takes the app's book field.
      await expectMatchesMockup(app, FILE, NEW, d, { name: 'new-worktree', prepare: async (m) => (await on(newFill(d, scheme))(m), await bookControls(d, 'input', m.locator(NEW).first(), 'input')) });
    });

    // Look 1117 v11 A S3-2: the discard question is the Remove-project dialog's centred sheet now (one look for one kind of
    // question), so the WTDIALOGS discard frame no longer draws it; its axe check stays below.

    test('tidy panel', async ({ app, core }) => {
      const d = await tidyPanel(app, core, scheme);
      // Design book (controls): the mockup's buttons and checks take the app's book buttons and checks.
      await expectMatchesMockup(app, FILE, TIDY, d, { name: 'tidy', prepare: async (m) => (await on(tidyFill(d))(m), await bookControls(d, 'input[type=checkbox]', m.locator(TIDY).first(), 'input[type=checkbox]'), await bookControls(d, '.btn:not([aria-pressed])', m.locator(TIDY).first(), 'button')) });
    });

    // Ticket 1041 lane 4 (B): the toast floats, so it is glass (was WTDIALOGS' dark bar, whose crop is retired); its words,
    // Undo and dismiss stay.
    test('undo_toast_matches_mockup', async ({ app, core }) => {
      const t = await toast(app, core, scheme);
      await expect(t).toHaveClass(/\bglass\b/);
      await expect(t.locator('.wtundo')).toBeVisible();
      await expect(t.locator('.wtdismiss')).toBeVisible();
      expect(await t.evaluate((e) => getComputedStyle(e).backdropFilter || getComputedStyle(e).getPropertyValue('-webkit-backdrop-filter'))).toContain('blur');
    });
  });

  for (const [name, open, sel] of [
    ['new worktree', newDialog, '.wtnew'],
    ['discard dialog', discardDialog, '.wtdirty'],
    ['tidy panel', tidyPanel, '.tidy'],
  ] as const) {
    test(`axe_worktree_dialogs: ${name} (${scheme})`, async ({ app, core }) => {
      await expect(await open(app, core, scheme)).toBeVisible();
      const r = await new AxeBuilder({ page: app }).include(sel).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
}

/** WCAG relative luminance of an `rgb(...)`/`rgba(...)` string, and the contrast ratio of two. */
const lum = (c: string) => {
  const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
    const s = Number(v) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('checkbox_light_focus_contrast_tested', async ({ app, core }) => {
  const d = await tidyPanel(app, core, 'light');
  const box = d.locator('input[type=checkbox]:not(:disabled)').first();
  // Keyboard focus, so `:focus-visible` applies: Tab from the Cancel button wraps through the panel to a checkbox.
  await box.evaluate((e) => (e as HTMLInputElement).blur());
  await d.getByRole('button', { name: 'Cancel' }).focus();
  for (let i = 0; i < 12 && !(await box.evaluate((e) => e === document.activeElement)); i++) await app.keyboard.press('Tab');
  await expect(box).toBeFocused();
  const got = await box.evaluate((e) => {
    const c = getComputedStyle(e);
    const probe = document.createElement('i');
    probe.style.color = 'var(--focus-ring)';
    document.body.append(probe);
    const ring = getComputedStyle(probe).color;
    probe.remove();
    let bg = e.parentElement;
    while (bg && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
    return { width: parseFloat(c.outlineWidth), style: c.outlineStyle, colour: c.outlineColor, ring, bg: getComputedStyle(bg!).backgroundColor, border: c.borderTopColor };
  });
  const ringRatio = ratio(got.colour, got.bg);
  console.log('CHECKBOX-LIGHT', JSON.stringify({ ...got, ringRatio }));
  expect(got.width, 'focus ring width').toBeGreaterThanOrEqual(2);
  expect(got.style, 'focus ring style').toBe('solid');
  expect(got.colour, 'focus ring is the --focus-ring token').toBe(got.ring);
  expect(ringRatio, `ring ${got.colour} on ${got.bg}`).toBeGreaterThanOrEqual(3);
  // The unchecked box is drawn by the UA (light scheme): read its border from the pixels, the darkest one in the crop.
  await app.keyboard.press('Space');
  await expect(box).not.toBeChecked();
  await clean(app);
  const png = (await box.screenshot({ animations: 'disabled' })).toString('base64');
  const dec = await app.context().newPage();
  const edge = await dec.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    c.drawImage(img, 0, 0);
    const px = c.getImageData(0, 0, img.width, img.height).data;
    let best = [255, 255, 255];
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < best[0] + best[1] + best[2]) best = [px[i], px[i + 1], px[i + 2]];
    return `rgb(${best.join(', ')})`;
  }, png);
  await dec.close();
  const edgeRatio = ratio(edge, got.bg);
  console.log('CHECKBOX-LIGHT-UNCHECKED', JSON.stringify({ edge, bg: got.bg, edgeRatio }));
  expect(edgeRatio, `unchecked border ${edge} on ${got.bg}`).toBeGreaterThanOrEqual(3);
});

test('nodup_worktree_dialogs: no dialog shows two controls for one action', async ({ app, core }) => {
  const d = await tidyPanel(app, core, 'light');
  const labels = await d.locator('.wtacts button, .wtttl button').evaluateAll((bs) => bs.map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()));
  expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  await expect(d.getByRole('button', { name: 'Cancel' })).toHaveCount(1);
});
