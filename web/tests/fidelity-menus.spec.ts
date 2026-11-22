// FIDELITY pass 3 (ticket 66): the row context menu, the Sessions search hit list and the agent/model picker menu
// against their approved drafts (STYLE 2026-10-28: ko/ tokens and Octicons). Pixels are Chromium only; the drafts 02, 05
// and 06 are R8-token pages, so their colours are first mapped to the app's own values (visual/r8-map.ts) and layout,
// type, radius and icon geometry are what is measured. None of the four drafts defines a dark scheme, so the pixel
// checks run in light; the token and axe checks run in both. WebKit pixels and the real WKWebView are not covered.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { openWindow, REPO, type Core } from './fixtures';
import { append, expect, rec, test } from './fixtures/chat/harness';
import { openQuiet } from './tree-seed';
import { expectMatchesMockup, measureMockup } from './visual/compare';
import { MOCKUPS } from './visual/mockups';
import { r8Map } from './visual/r8-map';
import { execFileSync } from 'node:child_process';

process.env.NUNCHIRO_VISUAL_OUT = path.join(REPO, '.scratch/fidelity-menus/visual');

// ---- the four drafts are byte copies with a README row each
test('drafts_copied_and_hashed', () => {
  const readme = fs.readFileSync(path.join(MOCKUPS, 'README.md'), 'utf8');
  for (const file of ['05-context-undo.html', '06-search.html', '02-agent-switch.html', 'round2.html']) {
    const p = path.join(MOCKUPS, file);
    expect(fs.existsSync(p), `${file} is missing from mockups/`).toBe(true);
    const sha = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const row = readme.split('\n').find((l) => l.startsWith(`| \`${file}\``));
    expect(row, `${file} has a README row`).toBeTruthy();
    expect(row, `${file}: README sha256`).toContain(sha);
    expect(row, `${file}: README names a decision`).toMatch(/V2SCREENS|V2ROUND2/);
  }
});

const git = (p: string, ...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
/** A repo with one worktree named like the draft's "v2-undo · worktree row"; its row carries the worktree menu. */
async function worktreeRow(app: Page, core: Core) {
  const p = core.project('lumen');
  git(p, 'init', '-q', '-b', 'main');
  git(p, 'commit', '-q', '--allow-empty', '-m', 'init');
  const w = (core.cli('worktree', 'create', '--project', p, '--branch', 'v2-undo', '--no-focus').worktrees as { path: string; branch: string }[]).find((x) => x.branch === 'v2-undo')!;
  core.cli('worktree', 'open', '--path', w.path, '--label', 'v2-undo', '--no-focus');
  openQuiet(core, 'lumen');
  await openWindow(app);
  const row = app.locator('[data-menu="worktree"]', { hasText: 'v2-undo' }).first();
  await expect(row).toBeVisible();
  return row;
}
const menu = (p: Page) => p.getByRole('menu', { name: 'Actions' });

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`context menu (${scheme})`, () => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, colorScheme: scheme });

    // Ticket 1041 lane 6 (polish-1121 A+B+C): the current item is the selected tint step and the menu floats on glass.
    test(`menu_selection_uses_hover_token (${scheme})`, async ({ app, core }) => {
      const row = await worktreeRow(app, core);
      await row.click({ button: 'right' });
      await expect(menu(app)).toBeVisible();
      const css = await app.evaluate(() => {
        const probe = (v: string, prop: 'backgroundColor' | 'color') => {
          const e = document.createElement('i');
          e.style[prop] = `var(${v})`;
          document.body.append(e);
          const c = getComputedStyle(e)[prop];
          e.remove();
          return c;
        };
        const cur = document.querySelector<HTMLElement>('.cmenu [role="menuitem"][data-current]')!;
        const box = document.querySelector<HTMLElement>('.cmenu')!;
        const s = getComputedStyle(cur);
        return { bg: s.backgroundColor, color: s.color, hover: probe('--select-bg', 'backgroundColor'), text: probe('--select-text', 'color'), shadow: getComputedStyle(box).boxShadow, pop: (() => {
          const e = document.createElement('i');
          e.style.boxShadow = 'var(--glass-shadow)';
          document.body.append(e);
          const v = getComputedStyle(e).boxShadow;
          e.remove();
          return v;
        })() };
      });
      expect(css.bg, 'current item fill is --select-bg').toBe(css.hover);
      expect(css.color, 'current item text is --select-text').toBe(css.text);
      expect(css.shadow, 'menu shadow is --glass-shadow').toBe(css.pop);
    });

    test(`axe_menus context menu (${scheme})`, async ({ app, core }) => {
      const row = await worktreeRow(app, core);
      await row.click({ button: 'right' });
      await expect(menu(app)).toBeVisible();
      const r = await new AxeBuilder({ page: app }).include('.cmenu').analyze();
      expect(r.violations.map((v) => v.id)).toEqual([]);
    });
  });
}

test.describe('pixels', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'pixel gate is Chromium only');

  // Ticket 1041 lane 6: draft 05's look (24 px rows, a 1 px border, rules between groups) is replaced by the approved
  // polish-1121 A+B+C, which draws no menu: menus are glass (light-glass.css), rows sit on the 32 px grid at 13 px, groups
  // part by a space. What 05 asked for and stays (the head naming the row, every key, the red removing item) is checked here.
  test('menus_match_mockup context menu (05 A, worktree row)', async ({ app, core }) => {
    const row = await worktreeRow(app, core);
    await row.click({ button: 'right' });
    await expect(menu(app)).toBeVisible();
    const got = await menu(app).evaluate((m) => {
      const cs = getComputedStyle(m);
      const item = m.querySelector<HTMLElement>('[role="menuitem"]')!;
      const sep = m.querySelector<HTMLElement>('.msep');
      return {
        border: cs.borderTopWidth,
        blur: cs.backdropFilter,
        radius: cs.borderTopLeftRadius,
        row: item.getBoundingClientRect().height,
        size: getComputedStyle(item).fontSize,
        sep: sep ? [sep.getBoundingClientRect().height, getComputedStyle(sep).backgroundColor] : null,
        head: m.querySelector('.mhd') ? getComputedStyle(m.querySelector('.mhd')!).fontSize : null,
        keys: [...m.querySelectorAll('[role="menuitem"] .kbd')].length,
        danger: [...m.querySelectorAll('[role="menuitem"][data-danger]')].map((e) => getComputedStyle(e).color),
      };
    });
    expect(got.border).toBe('0px');
    expect(got.blur).toContain('blur');
    expect(got.radius).toBe('12px');
    expect(got.row).toBe(32);
    expect(got.size).toBe('13px');
    expect(got.sep).toEqual([8, 'rgba(0, 0, 0, 0)']);
    expect(got.head).toBe('11px');
    expect(got.keys).toBeGreaterThan(0);
    const bad = await app.evaluate(() => { const e = document.createElement('i'); e.style.color = 'var(--bad-text)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; });
    expect(got.danger.length).toBeGreaterThan(0);
    for (const c of got.danger) expect(c).toBe(bad);
  });
});

// ---- the agent/model picker menu: its upper group label and the ko picker / draft 02 pixels
const PICKER_FIXTURES = path.join(REPO, 'crates/nunchiro/tests/fixtures');
async function openPicker(app: Page, core: Core) {
  fs.copyFileSync(path.join(PICKER_FIXTURES, 'claude-picker'), path.join(core.home, 'bin/claude'));
  fs.copyFileSync(path.join(PICKER_FIXTURES, 'codex-picker'), path.join(core.home, 'bin/codex'));
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('demo'), '--label', 'claude', '--model', 'opus').session as { id: string };
  await openWindow(app);
  await expect.poll(() => core.read(s.id)).toContain('❯');
  await app.locator('[data-picker="model"]').click();
  const pop = app.locator('[data-menu="model"]');
  await expect(pop).toBeVisible();
  await app.mouse.move(5, 5);
  return Object.assign(pop, { sessionId: s.id });
}
/** Whole-pixel box for the pixel measurement: a content-sized menu sits at a fractional x and width, and the two crops then round differently. */
const snap = (pop: ReturnType<Page['locator']>) =>
  pop.evaluate((e) => {
    const r = e.getBoundingClientRect();
    Object.assign(e.style, { position: 'fixed', right: 'auto', bottom: 'auto', left: `${Math.round(r.left)}px`, top: `${Math.round(r.top)}px`, width: `${Math.ceil(r.width)}px`, boxSizing: 'border-box' });
  });

test('picker_group_label_present', async ({ app, core }) => {
  const pop = await openPicker(app, core);
  const labels = await pop.locator('.pk-group').allTextContents();
  // W35 mockup 2: the hand-off group moved under More models ›; Fast mode is the menu's second group.
  expect(labels).toEqual(['Claude · this conversation only', 'Fast mode']);
  // The scope label sits above the first model row; the Fast mode label sits under the models and a rule.
  const order = await pop.locator('li').evaluateAll((els) => els.map((e) => (e.className === 'pk-group' ? 'label' : e.getAttribute('role'))));
  expect(order.slice(0, 2)).toEqual(['label', 'menuitemradio']);
  expect(order.indexOf('separator')).toBeLessThan(order.lastIndexOf('label'));
  // End the fake agent before the core's home is removed under it.
  core.cli('session', 'close', pop.sessionId);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe_menus picker and palette (${scheme})`, async ({ app, core }) => {
    test.info().annotations.push({ type: 'scheme', description: scheme });
    await app.emulateMedia({ colorScheme: scheme });
    await openPicker(app, core);
    expect((await new AxeBuilder({ page: app }).include('.pk-menu').analyze()).violations.map((v) => v.id)).toEqual([]);
    await app.keyboard.press('Escape');
    await app.keyboard.press('Meta+KeyK');
    await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    expect((await new AxeBuilder({ page: app }).include('.palette').analyze()).violations.map((v) => v.id)).toEqual([]);
    // The selected palette row reads as the menus do: the selected tint step (ticket 1041 lane 6).
    const [bg, hover] = await app.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.backgroundColor = 'var(--select-bg)';
      document.body.append(probe);
      const h = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(document.querySelector('.palette li[aria-selected="true"]')!).backgroundColor, h];
    });
    expect(bg).toBe(hover);
  });
}

test.describe('picker pixels', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'pixel gate is Chromium only');

  /** The app menu's rows as plain data, so a draft can be given the app's own text (the draft's is Korean or other agents). */
  const rowsOf = (pop: ReturnType<Page['locator']>) =>
    pop.locator('li').evaluateAll((els) =>
      els.map((e) => {
        const c = e.className;
        if (c === 'pk-sep') return { kind: 'sep', text: '', on: false };
        if (c === 'pk-group') return { kind: 'cap', text: e.textContent!, on: false };
        const on = e.getAttribute('aria-checked') === 'true';
        return { kind: 'item', text: on ? `✓ ${e.textContent!.replace('✓', '')}` : e.textContent!, on };
      }),
    );

  // W35 (owner 11-20): the round2 #s02 picker gate is retired; mockup 2 (docs/design/model-picker-1120) supersedes it and
  // picker-modes.spec.ts takes its shots for the comparison.

  // Reference measurement, not a gate: draft 02 (R8 era: 12px rows, 10px upper-case headers, a "Switch to" list of agents) and
// round2 `#s02` (the ko picker: 13px rows, group captions) draw different pickers, and STYLE (2026-10-28 16:08) makes the
// ko/ one canonical. Both cannot be within 2%, so round2 is the gate above and the 02 distance is recorded for the REPORT.
test('menus_reference picker (02 Option B, .pop)', async ({ app, core }) => {
    const pop = await openPicker(app, core);
    await snap(pop);
    const rows = await rowsOf(pop);
    const map = r8Map(app);
    const ratio = await measureMockup(app, '02-agent-switch.html', '#opt-b .pop', pop, {
      name: 'picker-02',
      prepare: async (m) => {
        await map(m);
        await m.locator('#opt-b .pop').first().evaluate((box, list) => {
          box.replaceChildren(
            ...list
              .filter((r) => r.kind !== 'sep')
              .map((r) => {
                const d = document.createElement('div');
                d.className = r.kind === 'cap' ? 'hd' : `it${r.on ? ' on' : ''}`;
                d.textContent = r.text;
                return d;
              }),
          );
          const r = box.getBoundingClientRect();
          (box as HTMLElement).style.transform = `translate(${Math.round(r.left) - r.left}px, ${Math.round(r.top) - r.top}px)`;
        }, rows);
      },
    });
    expect(ratio).toBeGreaterThanOrEqual(0);
  });
});

// ---- the Sessions search hit list (06 Option A): four sessions, five hits for "retire", filter chips
type Group = { name: string; kind: string; count: string; state: string; project: string; hits: { who: string; html: string; selected: boolean }[] };

test.describe('search pixels', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  test.skip(({ browserName }) => browserName !== 'chromium', 'pixel gate is Chromium only');

  async function openHits(page: Page, core: Core & { chat: (label: string) => { id: string; file: string } }) {
    const seedSession = (label: string, texts: string[], close = false) => {
      const s = core.chat(label);
      append(s.file, ...texts.map((t) => rec.assistant(t)));
      if (close) core.cli('session', 'close', s.id);
    };
    // The window lists the newest session first, the draft lists core-serve first: created in the reverse order.
    seedSession('v1a-16', ['worktree remove should retire sessions first'], true);
    seedSession('relay-check', ['holder must not retire the PTY master before the core detaches']);
    seedSession('v1a-40', ['scrollback ring: retire the oldest chunk when over 1 MiB'], true);
    seedSession('core-serve', ['The group was not retired before reap, so a zombie could stay.', 'self.retire_group(pgid)?; then reap']);
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const panel = page.locator('.sbar .spanel');
    await panel.getByRole('radio', { name: 'Sessions' }).click();
    await panel.getByRole('searchbox').fill('retire');
    await panel.getByRole('searchbox').press('Enter');
    await expect(panel.locator('.sscope:not([hidden]) .sstat')).toHaveText(/^5 matches in 4 sessions/);
    await page.mouse.move(900, 600);
    return panel;
  }

  test('menus_match_mockup search hit list (06 A, Sessions scope)', async ({ page, chatCore: core }) => {
    const panel = await openHits(page, core);
    const hits = panel.locator('.sscope:not([hidden]) .hits');
    const box = (await hits.boundingBox())!;
    const groups: Group[] = await hits.locator('.sgrp').evaluateAll((els) =>
      els.map((g) => ({
        name: g.querySelector('.sgh .n')!.textContent!,
        kind: g.querySelector('.sgh .k')?.textContent ?? '',
        count: g.querySelector('.sgh .c')?.textContent ?? '',
        state: g.querySelector('.sgd')?.getAttribute('data-state') ?? 'closed',
        project: g.querySelector('.sgp')?.textContent ?? '',
        hits: [...g.querySelectorAll('.hit')].map((h) => ({ who: h.querySelector('.sln')!.textContent!, html: h.querySelector('.stx')!.innerHTML, selected: h.getAttribute('aria-selected') === 'true' })),
      })),
    );
    // Ticket 1041 lane 7b (N081): a running session's dot is the working light's blue, not the draft's grey fill.
    const run = await hits.locator('.sgd[data-state="running"]').first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const map = r8Map(page);
    await expectMatchesMockup(page, '06-search.html', '#o6a [role="listbox"]', hits, {
      name: 'search-hits',
      prepare: async (m) => {
        await map(m);
        // The draft's rows (sessions, ages, times, projects) are not what a test can make the core say: its own markup and
        // inline styles are cloned per app row, with the app's text, so the pixels measure style, not data.
        await m.locator('#o6a [role="listbox"]').first().evaluate(
          (lb, [list, h, run]) => {
            const [head, proj, sel, opt] = [...lb.children] as HTMLElement[];
            const out: Node[] = [];
            for (const g of list as Group[]) {
              const hd = head.cloneNode(true) as HTMLElement;
              hd.querySelector('i')!.className = `st ${g.state === 'running' ? 'work' : 'done'}`;
              if (g.state === 'running') Object.assign(hd.querySelector('i')!.style, { background: run, borderColor: run });
              hd.querySelector('b')!.textContent = g.name;
              const [kind, count] = [...hd.querySelectorAll('.dim')];
              kind.textContent = g.kind;
              count.textContent = g.count;
              const pj = proj.cloneNode(true) as HTMLElement;
              pj.textContent = g.project;
              out.push(hd, pj);
              for (const x of g.hits) {
                const o = (x.selected ? sel : opt).cloneNode(true) as HTMLElement;
                o.innerHTML = `<span class="dim mono" style="font-size:10px">${x.who}</span> ${x.html}`;
                out.push(o);
              }
            }
            lb.replaceChildren(...out);
            Object.assign((lb as HTMLElement).style, { flex: 'none', height: `${h}px` });
          },
          [groups, box.height, run] as const,
        );
      },
    });
  });

  // The filter chips (draft 06 A) are a gate. The draft's chips are divs and the app's are native selects with an Octicon caret, so the
  // caret is laid out at its real width in both but painted in neither: a caret glyph, or its blink, cannot move the ratio.
  test('search_chips_in_visual_gate', async ({ page, chatCore: core }) => {
    const panel = await openHits(page, core);
    const filt = panel.locator('.sscope:not([hidden]) .sfilt');
    const texts = await filt.locator('.spill select').evaluateAll((els) => els.map((e) => (e as HTMLSelectElement).selectedOptions[0].textContent!));
    const { x, y, height } = (await filt.boundingBox())!;
    // What the caret takes of a pill's width (its box less the negative margins that tuck it in).
    const caret = await filt.locator('.spill .oi').first().evaluate((e) => {
      const cs = getComputedStyle(e);
      return e.getBoundingClientRect().width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
    });
    // Ticket 1041 lane 7b (N150, owner 2026-11-22: no outlined boxes): the pills are a tint without a border, "Closed too" on is
    // the selected step; the draft's chips take the app's fills and lose their borders, so the gate measures the rest.
    const fills = await filt.locator('.spill, .sclosed').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    const map = r8Map(page);
    await page.addStyleTag({ content: '.spill .oi { visibility: hidden }' });
    await expectMatchesMockup(page, '06-search.html', '#o6a .dock.l > div:nth-child(3)', filt, {
      name: 'search-chips',
      prepare: async (m) => {
        await map(m);
        // The draft says "Project: all"; the app's selects say what the option reads. Same chips, the app's words.
        await m.locator('#o6a .dock.l > div:nth-child(3)').first().evaluate((row, [t, height, caret, x, y, fills]) => {
          const chips = [...row.querySelectorAll('.chip')] as HTMLElement[];
          chips.forEach((c, i) => Object.assign(c.style, { border: '0', background: fills[i] }));
          (row as HTMLElement).style.borderBottom = '0'; // the row's rule is gone too (spacing parts it from the hits)
          // The draft's chip puts a 4px gap before its caret; the app's pill has none, so the unpainted stand-in takes the gap out of its width.
          t.forEach((w, i) => (chips[i].innerHTML = `${w} <span style="visibility:hidden;display:inline-block;width:${caret - 4}px"></span>`));
          chips[3].textContent = '✓ Closed too';
          (row as HTMLElement).style.height = `${height}px`;
          const r = row.getBoundingClientRect();
          // The app's row sits on a fractional pixel (the crop's edges are rounded out); the draft's row sits on the same fraction.
          (row as HTMLElement).style.transform = `translate(${Math.floor(r.left) + (x % 1) - r.left}px, ${Math.floor(r.top) + (y % 1) - r.top}px)`;
        }, [texts, height, caret, x, y, fills] as const);
      },
    });
  });
});

// ---- axe: the search results open, light and dark (the context menu, picker and palette are checked above)
for (const scheme of ['light', 'dark'] as const) {
  test(`axe_menus search results (${scheme})`, async ({ page, chatCore: core }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const s = core.chat('alpha');
    append(s.file, rec.assistant('We retire the process group before reap.'));
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const panel = page.locator('.sbar .spanel');
    await panel.getByRole('radio', { name: 'Sessions' }).click();
    await panel.getByRole('searchbox').fill('retire');
    await panel.getByRole('searchbox').press('Enter');
    await expect(panel.locator('.sscope:not([hidden]) .hit')).toHaveCount(1);
    const r = await new AxeBuilder({ page }).include('.sbar .spanel').analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
}

// ---- the four tokens the menu, search and picker CSS read are declared once, in tokens.css
test('tokens_defined_once', () => {
  const src = path.join(REPO, 'web/src');
  const css: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.css')) css.push(f);
    }
  };
  walk(src);
  const rel = (f: string) => path.relative(src, f);
  for (const name of ['--mark', '--mark-text', '--fs-10', '--sp-3']) {
    const decl = new RegExp(`(^|[\\s;{])${name}\\s*:`, 'g');
    const where = css.flatMap((f) => Array(fs.readFileSync(f, 'utf8').match(decl)?.length ?? 0).fill(rel(f)));
    expect(where, `${name} is declared once, in tokens.css`).toEqual(['tokens.css']);
  }
  for (const f of css) {
    const text = fs.readFileSync(f, 'utf8');
    expect(text, `${rel(f)}: calc(var(--fs-11) - 1px) is --fs-10`).not.toMatch(/calc\(var\(--fs-11\) - 1px\)/);
    expect(text, `${rel(f)}: calc(var(--sp-4) - 1px) is --sp-3`).not.toMatch(/calc\(var\(--sp-4\) - 1px\)/);
  }
});
