// Visual conformance gate (fidelity step 2, STYLE 2026-10-28). Chromium only: each component is cropped from its ko/
// mockup and from the app in the same run, at the same viewport (1440x900) and deviceScaleFactor 2, and the two crops
// are compared in the page with pixelmatch's rules (YIQ colour delta at threshold 0.1, anti-aliased pixels ignored).
// A component passes at <= 2% differing pixels. Crops of different sizes are compared on their overlap, and every
// pixel outside it counts as differing, so a height or layout gap shows in the number. The mockup element takes the app
// element's width first: the mockups are 300px doc panes and the app tree is 256px, a layout fact, not style. How to add a component:
// tests/visual/README.md. WebKit pixels and the real Tauri WKWebView are not covered.
import type { Page } from '@playwright/test';
import { PATHS } from '../src/icons/Icon';
import { defaultBars } from '../src/layout/bars';
import { expect, openWindow, test } from './fixtures';
import { openQuiet } from './tree-seed';
import { expectMatchesMockup, koRows, measureMockup, patchSnapshots, repo, worktree } from './visual/compare';
import { mockup as mockupPath } from './visual/mockups';

test.use({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
test.skip(({ browserName }) => browserName !== 'chromium', 'pixel gate is Chromium only');
test.beforeEach(({ app }) => koRows(app)); // the ko/ mockups' 30 px rows (ticket 1041 lane 1)

for (const scheme of ['light', 'dark'] as const) {
  // Ticket 1041 lane 4: the session row, project head, decision line and folded group head follow the approved
  // docs/design/polish-1121 mockup now (no rail, state light and word, 32 px heads, one-row decision line); their ko/
  // crops are retired and tree-polish-1041.spec.ts measures the rows against the polish mockup.
  test(`visual_conformance whole tree pane (${scheme}, measured for the side-by-side page)`, async ({ app, core }) => {
    const p = repo(core, 'lumen');
    worktree(core, p, 'feature-x');
    worktree(core, p, 'build-fix');
    worktree(core, p, 'v2-theme');
    openQuiet(core, 'lumen');
    await patchSnapshots(app, { 'build-fix': { waiting: 'permission', text: 'npm test 실행 허용?' }, 'v2-theme': { waiting: 'question', text: '테스트 3건 실패, 진행?' } });
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await openWindow(app);
    await app.mouse.move(900, 600);
    await expect(app.locator('.grp[data-project="lumen"] .q')).toHaveCount(2);
    // The whole pane is a reference picture for owner, not a gate: the window frame around it has no mockup yet (FRAME).
    const r = await measureMockup(app, 'hiderows-r6.html', '.pane', app.locator('.grp[data-project="lumen"]'), { name: 'tree-pane' });
    expect(r).toBeGreaterThanOrEqual(0);
  });
}

// ---- LAYOUT D5b lane B: a sub-view under a project row against ko/layout-d5b.html `.view` (closed, and open with its body).
// The mockup is Korean with emoji; its text is set to the app's English copy on the mockup page (`prepare`), so the diff
// measures the sub-view's look. The open body holds the real Agents widget where the mockup draws two placeholder lines.
// layout-d5b.html ends inside its <script> (no closing tag), so a browser never runs it; the script is re-run here from
// the element's own text, the file stays as approved.
const english = (open: boolean) => async (m: Page) => {
  await m.evaluate(([o, chevron]) => {
    const code = document.querySelector('script')!.textContent!;
    const run = document.createElement('script');
    run.textContent = code;
    document.body.append(run);
    if (!o) (document.querySelector('.view .vh') as HTMLElement).click(); // a click re-renders: toggle first, then set the text
    const vh = document.querySelector('.view .vh') as HTMLElement;
    // The glyph is the Octicon the owner's STYLE decision put in its place (the same path the app draws).
    vh.querySelector('.chv')!.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" style="display:block"><path d="${chevron}"/></svg>`;
    for (const n of [...vh.childNodes]) if (n.nodeType === 3) n.textContent = '';
    vh.querySelector('.chv')!.after(document.createTextNode('Agents '));
    vh.querySelector('.tagv')!.textContent = 'view';
    // The mockup's first view sits at a half-pixel offset, which makes its crop one row taller; put it on a whole CSS pixel (element crops round to those).
    const y = vh.parentElement!.getBoundingClientRect().top;
    document.body.style.paddingTop = `${20 + Math.ceil(y) - y}px`;
  }, [open, PATHS['chevron-right']] as const);
};
for (const scheme of ['light', 'dark'] as const) {
  for (const open of [false, true]) {
    test(`subview_matches_mockup ${open ? 'open' : 'closed'} (${scheme})`, async ({ app, core }) => {
      const p = repo(core, 'nunchiro');
      core.shell(p, 'one');
      openQuiet(core, 'nunchiro');
      const bars = { ...defaultBars(), nest: { [p]: ['agents'] }, open: { [`${p}::agents`]: open } };
      await app.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), ['nunchiro.settings.v1', { bars }] as const);
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await openWindow(app);
      await app.mouse.move(900, 600);
      const view = app.locator('.grp[data-project="nunchiro"] .view');
      await expect(view).toBeVisible();
      // Ticket 1041 (N058, N117): the "view" tag is a neutral tint mark without the purple outline; the mockup's tag takes the
      // app's tag colours so the crop measures the rest of the head.
      const tag = await view.locator('.tagv').evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, c: getComputedStyle(e).color }));
      const polish = async (m: Page) => void (await m.addStyleTag({ content: `.view .tagv{border:0!important;background:${tag.bg}!important;color:${tag.c}!important}` }));
      if (!open) return expectMatchesMockup(app, 'layout-d5b.html', '.view', view, { name: 'subview-closed', prepare: async (m) => (await english(false)(m), await polish(m)) });
      // Open: the mockup's body is two placeholder lines, the app's is the real Agents widget, so the pixel share below is
      // content, not style (measured and recorded for the side-by-side page, never a pass condition). What the mockup
      // fixes for the body is its frame: indent, padding, the --done left rule, background and corner radius.
      const ratio = await measureMockup(app, 'layout-d5b.html', '.view', view, { name: 'subview-open', prepare: english(true) });
      expect(ratio).toBeGreaterThanOrEqual(0);
      const FRAME = ['marginLeft', 'marginBottom', 'paddingTop', 'paddingLeft', 'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor', 'backgroundColor', 'borderTopRightRadius', 'borderBottomRightRadius'] as const;
      const frame = (e: Element, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, getComputedStyle(e)[k as 'color']]));
      const m = await app.context().newPage();
      await m.setViewportSize({ width: 1440, height: 900 });
      await m.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await m.goto(`file://${mockupPath('layout-d5b.html')}`);
      await english(true)(m);
      const want = await m.locator('.view .vb').first().evaluate(frame, FRAME);
      // Ticket 515 (owner pick 11-12): the app snaps the mockup's 5px corner to --r-6.
      for (const k of ['borderTopRightRadius', 'borderBottomRightRadius'] as const) if (want[k] === '5px') want[k] = '6px';
      // Ticket 1041: the body is one tint step (--tint-1) with no purple left rule.
      Object.assign(want, { borderLeftWidth: '0px', borderLeftStyle: 'none', borderLeftColor: await view.locator('.vb').evaluate((e) => getComputedStyle(e).color), backgroundColor: await view.evaluate((e) => { const d = document.createElement('i'); d.style.backgroundColor = 'var(--tint-1)'; e.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; }) });
      await m.close();
      expect(await view.locator('.vb').evaluate(frame, FRAME)).toEqual(want);
    });
  }
}
