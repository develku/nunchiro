// R8 drafts (02, 05, 06) name their colours --bg --g0..--g7 --ink ...; the app has the same names as aliases of the ko/
// roles. `prepare` writes the APP page's computed value of each name into the DRAFT page, so layout, type, radius and
// icon geometry are what the pixels measure and no hex is copied by hand.
import type { Page } from '@playwright/test';

const NAMES = ['--bg', '--g0', '--g1', '--g2', '--g3', '--g4', '--g5', '--g6', '--g7', '--ink', '--icon', '--signal', '--signal-text', '--signal-soft', '--focus', '--bad', '--ok', '--term-bg'];
// STYLE (2026-10-28) drops the R8 ink-on-bg selection: the draft's selected item reads as the app's hover fill.
const NO_INVERSION = '.mi.on,.mi.dz.on{background:var(--g2)!important;color:var(--ink)!important}.mi.on .k{color:var(--g5)!important}.mi.dz.on{color:var(--bad)!important}';

/** A `prepare` for expectMatchesMockup: `app` is the page whose tokens the draft takes. */
export function r8Map(app: Page, opts: { selection?: boolean } = {}) {
  return async (m: Page) => {
    const values = await app.evaluate((names) => names.map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()] as const), NAMES);
    const css = `:root{${values.map(([n, v]) => `${n}:${v}`).join(';')}}${opts.selection ? NO_INVERSION : ''}`;
    await m.addStyleTag({ content: css });
  };
}
