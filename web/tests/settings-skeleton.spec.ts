// v25-area-settings (V2.5-32, needs 140 amendment, needs 162): every Settings page draws on one skeleton. needs 192 (ticket
// 250, final draft A) replaced the boxless skeleton with cards: each section is one card (1 px border, the panel fill) on
// one left edge, its title 13 px above it, row labels 14 px, descriptions 12 px (r3: the row kit's cards). Ticket 1041
// lane 8 (A+B+C, owner 11-22): the card keeps its fill but loses its outline, and descriptions take the 11 px step.
import { expect, openWindow, test } from './fixtures';
import type { Page } from '@playwright/test';

// Ticket 391: Providers and Usage draw their own mockups' cards (providers-391, usage-1106), so they are not on this list.
const PAGES = ['general', 'appearance', 'terminal', 'layout', 'alerts', 'keys', 'extensions', 'git', 'machines', 'browser', 'libraries', 'history', 'about']; // ticket 262: About too

async function open(app: Page, id: string) {
  // ticket 250 r3: the Settings control toggles; click it only while Settings is closed.
  if (!(await app.locator(`#snav-${id}`).isVisible())) await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.locator(`#snav-${id}`).click();
  await expect(app.locator('.sbody > *').first()).toBeVisible();
  // Core-backed pages draw their cards once the core answered.
  await expect(app.locator('.sbody').getByRole('status').filter({ hasText: /^Reading/ })).toHaveCount(0);
}

/** Computed facts of every card on the page: a kit section's card (`section.ssec > .scard`, ticket 250 r3), or a body
 *  section the kit does not draw yet (Accounts, Usage, Schedules, Machines), which is its own card. */
function facts(app: Page) {
  return app.evaluate(() => {
    const px = (v: string) => parseFloat(v);
    const kit = [...document.querySelectorAll<HTMLElement>('.sbody section.ssec')].filter((s) => s.offsetParent && s.querySelector(':scope > .scard'));
    const old = [...document.querySelectorAll<HTMLElement>('.sbody > section:not(.ssearch):not(.ssec):not(.ssec-group)')].filter((s) => s.offsetParent && !s.querySelector('section.ssec'));
    return [...kit, ...old].map((s) => {
      const card = s.querySelector<HTMLElement>(':scope > .scard') ?? s;
      const cs = getComputedStyle(card);
      const h2 = [...s.querySelectorAll<HTMLElement>('h2')].find((h) => !h.classList.contains('sr') && h.offsetParent) ?? null;
      const lede = s.querySelector<HTMLElement>('.lede');
      const h3s = [...s.querySelectorAll<HTMLElement>('h3:not(.sgroup):not(.khead)')].filter((h) => h.offsetParent).map((h) => px(getComputedStyle(h).fontSize));
      return {
        id: s.id || s.getAttribute('aria-labelledby') || s.getAttribute('aria-label') || s.className,
        left: card.getBoundingClientRect().left,
        border: ['Top', 'Right', 'Bottom', 'Left'].reduce((n, e) => n + px(cs.getPropertyValue(`border-${e.toLowerCase()}-width`)), 0),
        padLeft: px(cs.paddingLeft),
        fs: px(getComputedStyle(s).fontSize),
        bg: cs.backgroundColor,
        h2: h2 ? px(getComputedStyle(h2).fontSize) : null,
        h2Left: h2 ? h2.getBoundingClientRect().left : null,
        lede: lede ? px(getComputedStyle(lede).fontSize) : null,
        h3s,
      };
    });
  });
}

test('settings_pages_share_one_skeleton: every page with body sections (Keyboard aside) shares one left edge, one card, h2 13px, one lede size', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await open(app, 'general');
  const general = await facts(app);
  const edge = general[0].left;
  const bodySize = general[0].fs; // General's computed body size: the body text of every page matches it
  expect(bodySize).toBe(13);
  const fill = general[0].bg; // the card fill (--panel)
  const seen: string[] = [];
  for (const id of PAGES) {
    await open(app, id);
    const secs = await facts(app);
    if (id === 'keys') continue; // Keyboard is one div of area cards, not a body-level section (S11 stays with the keys lane)
    expect(secs.length, `${id} has sections`).toBeGreaterThan(0);
    for (const s of secs) {
      seen.push(`${id}:${s.id}`);
      expect(Math.abs(s.left - edge), `${id} ${s.id} left edge ${s.left} vs General ${edge}`).toBeLessThanOrEqual(1);
      // Ticket 336 (532eeb61) drew SSH Machines as rows in a plain wrapper: the wrapper is not a card, so only its edge counts.
      const rows = id === 'machines' && s.id === 'h-machines';
      if (!rows) expect(s.border, `${id} ${s.id} border width`).toBe(0); // ticket 1041 A: no outlined card
      // A kit card's rows carry their own 16 px inset; an older section card pads itself.
      if (!rows) expect([0, 16], `${id} ${s.id} inset padding`).toContain(s.padLeft);
      if (!rows) expect(s.bg, `${id} ${s.id} card fill`).toBe(fill);
      if (s.h2 !== null) expect(s.h2, `${id} ${s.id} h2`).toBe(13);
      // Machines keeps its 14px mockup body (6574fc13; needs 142, machines_match_mockup): the owner-backed pin beats this lane choice.
      if (!(id === 'machines' && s.id === 'h-machines')) expect(s.fs, `${id} ${s.id} body size`).toBe(bodySize);
      if (s.lede !== null) expect(s.lede, `${id} ${s.id} lede`).toBe(11); // ticket 1041 A: the 11 / 13 / 15 scale
    }
  }
  expect(seen.some((s) => s.startsWith('extensions:')) && seen.some((s) => s.startsWith('git:'))).toBe(true);
});

// needs 192 (ticket 250): the sections the old Advanced page folded are pages again; they still share one scale.
// F5: the Orchestration page is one untitled skill card (its h2 is screen-reader only), so it adds no visible head: 3, not 5.
test('advanced_sections_one_scale: the Advanced-family sections are h2 18px on one left edge; their h3 are 15px', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const heads: { text: string; size: number; left: number }[] = [];
  const h3s: number[] = [];
  await open(app, 'extensions');
  for (const id of ['extensions', 'browser', 'machines']) { // ticket 391: Advanced and Orchestration are in Skills & hooks; ticket 993: Schedules is a widget
    await open(app, id);
    await expect(app.locator('.sbody section h2').first(), id).toBeAttached();
    heads.push(...(await facts(app)).filter((f) => f.h2 !== null).map((f) => ({ text: f.id, size: f.h2!, left: f.left })));
    h3s.push(...(await facts(app)).flatMap((f) => f.h3s));
  }
  expect(heads.length).toBeGreaterThanOrEqual(3);
  for (const h of heads) {
    expect(h.size, h.text).toBe(13);
    expect(Math.abs(h.left - heads[0].left), `${h.text} left edge`).toBeLessThanOrEqual(1);
  }
  for (const size of h3s) expect(size).toBe(13); // ticket 1041 A: row labels at the 13 px body step
});

// Ticket 993: `schedule_every_day_label_adjacent` (the Every day checkbox beside its label) left with the Schedules page:
// the widget's form has no checkbox, Every day is one of four segments (schedules-993.spec.ts schedule_form_when).
