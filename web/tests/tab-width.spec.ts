// Owner 11-17: "the tab's blank room is needlessly large". A theme-card rule (.tname) padded every tab's name by 40px, and the
// room kept for the hidden Stop button was blank too. A tab has no Stop now: the only room after the name is Close's own.
import { expect, openWindow, test } from './fixtures';
import { patchSnapshots } from './visual/compare';

test('tab_is_as_wide_as_its_parts: the only room after the name is the room of the Close button; no Stop; a hover changes neither the width nor the name', async ({ app, core }) => {
  core.shell(core.project('demo'), 'shell-1');
  await openWindow(app);
  const tab = app.locator('.tabw').first();
  await expect(tab.locator('.tname')).toHaveText(/shell-1/);
  const measure = () =>
    tab.evaluate((e) => {
      const name = e.querySelector('.tname')!;
      return { pad: getComputedStyle(name).paddingRight, after: Math.round(e.getBoundingClientRect().right - name.getBoundingClientRect().right), width: Math.round(e.getBoundingClientRect().width) };
    });
  const rest = await measure();
  expect(rest.pad).toBe('0px');
  expect(rest.after).toBeLessThanOrEqual(38); // Close (24 with its press area), the book's 8 gap and 6 padding
  const nameWidth = () => tab.locator('.tname').evaluate((e) => Math.round(e.getBoundingClientRect().width));
  const name = await nameWidth();
  await tab.hover();
  await expect(tab.locator('button')).toHaveCount(1); // Close only: no Stop beside it
  await expect(tab.locator('.x')).toBeVisible();
  expect((await measure()).width).toBe(rest.width); // needs 26: a hovered tab never changes width
  expect(await nameWidth()).toBe(name); // and its name is not cut
  // Close is inside the tab's box and after the name's box: nothing lies over text.
  const ok = await tab.evaluate((e) => {
    const box = e.getBoundingClientRect();
    const name = e.querySelector('.tab')!.getBoundingClientRect();
    const close = e.querySelector('.x')!.getBoundingClientRect();
    return close.left >= name.right && close.right <= box.right;
  });
  expect(ok).toBe(true);
});

test('tab_menu_ends_session: an idle shell’s tab menu offers Close session (no Stop: there is no turn to stop), and it ends the session', async ({ app, core }) => {
  // An idle shell, as the core starts it. (A merge had left the other fix's "working" patch on this test: red on main,
  // since a shell at work offers Stop. That case is the next test.)
  const s = core.shell(core.project('demo'), 'shell-1');
  await openWindow(app);
  const tab = app.locator(`.tab[data-tab="${s.id}"]`);
  await expect(tab.locator('.tdot')).not.toHaveAttribute('data-s', 'done');
  await tab.click({ button: 'right' });
  const menu = app.getByRole('menu', { name: 'Actions' });
  await expect(menu.getByRole('menuitem', { name: 'Stop this session' })).toHaveCount(0); // 4bf0a62d4
  await menu.getByRole('menuitem', { name: 'Close session' }).click();
  // The session is over: its tab is gone, or stays as a done tab.
  await expect.poll(async () => (await tab.count()) === 0 || (await tab.locator('.tdot').getAttribute('data-s')) === 'done').toBe(true);
});

// 4bf0a62d4's other half: a shell running a command keeps Stop (chrome/closeEnded.ts `stoppable`).
test('tab_menu_stops_session: a shell at work offers Stop this session in its tab menu, and it stops the session', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'shell-1');
  await patchSnapshots(app, { 'shell-1': { working: true } }); // the core cannot hold a shell "working" on demand
  await openWindow(app);
  const tab = app.locator(`.tab[data-tab="${s.id}"]`);
  await expect(tab.locator('.tdot')).not.toHaveAttribute('data-s', 'done');
  await tab.click({ button: 'right' });
  const menu = app.getByRole('menu', { name: 'Actions' });
  await expect(menu.locator('[data-command="session.close"]')).toHaveAttribute('aria-disabled', 'true'); // Close session is the idle shell's
  await menu.getByRole('menuitem', { name: 'Stop this session' }).click(); // a shell stops at once
  await expect(tab.locator('.tdot')).toHaveAttribute('data-s', 'done');
});

// Ticket 996 (owner 11-19, draft A; mockup docs/design/tabs-sizing-1119.html): tabs share the strip and shrink together from
// 180 px to 68 px, where the icon, the dot and a few letters still show; the shown tab keeps its whole name; only below that
// floor does the strip scroll (with the active tab in view).
test('full_strip_shrinks_then_scrolls: tabs shrink to 68-180 px with a few letters each, the shown one keeps its name; a strip scrolls only at the floor', async ({ app, core }) => {
  const p = core.project('demo');
  for (let i = 1; i <= 8; i++) core.shell(p, `a-long-session-name-${i}`);
  for (const width of [1000, 2400]) {
    await app.setViewportSize({ width, height: 700 });
    if (width === 1000) {
      await openWindow(app);
      for (let i = 1; i <= 8; i++) await app.locator('.tree .row.wt2').filter({ hasText: `a-long-session-name-${i}` }).first().click();
    }
    const m = await app.locator('.tabs').first().evaluate((e) => {
      // Seen letters: how many of a name's first characters lie on its one drawn line, inside its box (.wordcut wraps the rest).
      const seen = (n: Element) => {
        const r = document.createRange();
        const box = n.getBoundingClientRect();
        let k = 0;
        while (k < n.textContent!.length) {
          r.setStart(n.firstChild!, 0);
          r.setEnd(n.firstChild!, k + 1);
          const line = r.getClientRects();
          if (line[line.length - 1].top > box.top + 2 || r.getBoundingClientRect().right > box.right + 1) break;
          k++;
        }
        return k;
      };
      return {
        scroll: e.scrollWidth > e.clientWidth + 1,
        tabs: [...e.querySelectorAll('.tabw:has(> .tab)')].map((w) => ({
          on: !!w.querySelector('[aria-selected="true"]'),
          width: Math.round(w.getBoundingClientRect().width),
          seen: seen(w.querySelector('.tname')!),
          length: w.querySelector('.tname')!.textContent!.length,
        })),
      };
    });
    expect(m.tabs.length).toBe(8);
    for (const t of m.tabs.filter((t) => !t.on)) {
      expect(t.width).toBeGreaterThanOrEqual(68);
      expect(t.width).toBeLessThanOrEqual(180);
      expect(t.seen).toBeGreaterThanOrEqual(2); // a few letters at the floor, not an icon and a dot only (look 1117 v4f)
      if (m.scroll) expect(t.width).toBeLessThanOrEqual(69); // the strip scrolls only once every other tab is at the floor
    }
    const on = m.tabs.find((t) => t.on)!;
    expect(on.seen).toBe(on.length); // the shown tab keeps its whole name
    if (m.scroll) {
      const [strip, active] = await Promise.all([app.locator('.tabs').first().boundingBox(), app.locator('.tabw:has(> .tab[aria-selected="true"])').first().boundingBox()]);
      expect(active!.x).toBeGreaterThanOrEqual(strip!.x - 1);
      expect(active!.x + active!.width).toBeLessThanOrEqual(strip!.x + strip!.width + 1);
    }
  }
});
