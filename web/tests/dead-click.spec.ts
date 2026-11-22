// needs 172: the dead-click gate. In each state the window can be in, every visible element that LOOKS clickable (pointer
// cursor, or a :hover rule that changes its background) must also be reachable by keyboard: natively interactive, a role
// of an interactive kind, or tabindex >= 0 (plus a handler, below). An offender is `<state>|<css path>|<text or aria-label, 24 chars>`.
// scripts/dead-click.baseline lists today's offenders; the spec fails on one that is not listed and prints it. A line
// that no longer offends is not an error: the lane that fixed it deletes the line (the scenario test refuses growth).
// DEAD_CLICK_WRITE=1 rewrites the baseline from the offenders found now (only for the first generation).
// A role or tabindex alone does not pass: a non-native element also needs a click-ish handler (`onClick`, `onMouseDown`,
// `onPointerDown` or `onKeyDown`) in React's props on the node itself or on its nearest interactive ancestor (native control,
// interactive role or `tabindex >= 0`); a handler on a plain wrapper does not count.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { icon } from './d5b';

const BASELINE = path.join(REPO, 'scripts/dead-click.baseline');
const FOUND = path.join(REPO, '.scratch/dead-click.found');

/** Runs in the page: the offenders of the current screen, tagged with `state`. */
const scan = (page: Page, state: string) =>
  page.evaluate((state) => {
    const NATIVE = 'button, a[href], input, select, textarea, summary, label[for], option';
    const ROLES = new Set(['button', 'tab', 'menuitem', 'link', 'option', 'checkbox', 'switch', 'treeitem']);
    // :hover rules that change a background, as selectors with the pseudo-class removed.
    const hover: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule && r.selectorText.includes(':hover') && (r.style.background || r.style.backgroundColor)) {
          for (const sel of r.selectorText.split(',')) if (sel.includes(':hover')) hover.push(sel.replace(/:hover/g, '').trim() || '*');
        } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A sheet from another origin: not ours.
      }
    }
    const looksClickable = (el: Element) =>
      getComputedStyle(el).cursor === 'pointer' || hover.some((s) => { try { return el.matches(s); } catch { return false; } });
    const interactive = (el: Element) => {
      const role = el.getAttribute('role');
      const ti = el.getAttribute('tabindex');
      return el.matches(NATIVE) || (role !== null && ROLES.has(role)) || (ti !== null && Number(ti) >= 0);
    };
    const HANDLERS = ['onClick', 'onMouseDown', 'onPointerDown', 'onKeyDown'];
    const hasHandler = (e: Element) => {
      const key = Object.keys(e).find((k) => k.startsWith('__reactProps$'));
      const props = key ? ((e as unknown as Record<string, Record<string, unknown>>)[key]) : undefined;
      return !!props && HANDLERS.some((h) => typeof props[h] === 'function');
    };
    // On the node itself, or on its nearest interactive ancestor (it answers the bubbled click). A handler on a plain
    // wrapper, or on an interactive element further up, stands in for no one (system3 review: a window-level key handler
    // on the root hid every dead role below it).
    const handled = (el: Element) => {
      if (hasHandler(el)) return true;
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (interactive(e)) return hasHandler(e);
      return false;
    };
    const css = (el: Element) => {
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement)
        parts.unshift(e.tagName.toLowerCase() + [...e.classList].filter((c) => !/^\d|^css-/.test(c)).map((c) => `.${c}`).join(''));
      return parts.join('>');
    };
    const out = new Set<string>();
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
      if (!looksClickable(el)) continue;
      // A role or tabindex only says "reachable by keyboard": a non-native control also needs a handler (React's props on
      // the node, or on an ancestor that answers the bubbled click).
      if (interactive(el) && (el.matches(NATIVE) || handled(el))) continue;
      // Inside an interactive element (a span in a button inherits its pointer): that element answers the click.
      const host = el.parentElement?.closest(`${NATIVE}, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"], [role="checkbox"], [role="switch"], [role="link"]`);
      if (host) continue;
      const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      out.add(`${state}|${css(el)}|${text}`);
    }
    return [...out];
  }, state);

const agent = (core: Core, label: string) => core.agent(core.project(label), label, 'never-created');

/** The ratchet itself: the offenders not in the baseline (scripts/dead-click-check.sh, also run by the scenario tests). */
function ratchet(found: string[]) {
  const now = [...new Set(found)].sort();
  if (process.env.DEAD_CLICK_WRITE) return void fs.writeFileSync(BASELINE, now.map((l) => `${l}\n`).join(''));
  fs.mkdirSync(path.dirname(FOUND), { recursive: true });
  fs.writeFileSync(FOUND, now.map((l) => `${l}\n`).join(''));
  const r = spawnSync('sh', [path.join(REPO, 'scripts/dead-click-check.sh'), BASELINE, FOUND], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

/** React keeps a node's props under `__reactProps$<id>`; plant the same key to stand for an onClick. */
const wire = (page: Page, ids: string[], handler = 'onClick') =>
  page.evaluate(([ids, handler]) => {
    for (const id of ids) (document.getElementById(id) as unknown as Record<string, unknown>)['__reactProps$test'] = { [handler]() {} };
  }, [ids, handler] as const);

test('dead_click_scan_finds_a_pointer_div_with_no_role', async ({ page }) => {
  await page.setContent(`<style>.x{cursor:pointer}.h:hover{background:#eee}</style>
    <div class="x">plain pointer</div>
    <div class="h">hover only</div>
    <div class="x" role="button" tabindex="0" id="fine">fine</div>
    <div class="x" tabindex="-1">still offends</div>
    <button class="x"><span>inside a button</span></button>
    <a class="x" href="/x">link</a>`);
  await wire(page, ['fine']);
  expect(await scan(page, 's')).toEqual(['s|div.x|plain pointer', 's|div.h|hover only', 's|div.x|still offends']);
});

test('dead_click_handler_check_flags_a_dead_role', async ({ page }) => {
  await page.setContent(`<style>.x{cursor:pointer}</style>
    <div class="x" role="button" tabindex="0" id="wired">wired</div>
    <div class="x" role="button" tabindex="0">dead role</div>
    <div class="x" tabindex="0">dead tabindex</div>
    <div id="row" tabindex="0"><div class="x" role="button" tabindex="0">under a handler</div></div>
    <button class="x">native</button>`);
  await wire(page, ['wired', 'row']);
  expect(await scan(page, 's')).toEqual(['s|div.x|dead role', 's|div.x|dead tabindex']);
});

test('dead_click_root_handler_does_not_hide_a_dead_role', async ({ page }) => {
  // system3 review SHOULD: a handler on a plain root div (a window-level key handler) answers no click on the dead role below it.
  await page.setContent(`<style>.x{cursor:pointer}</style>
    <div id="root"><div class="x" role="button" tabindex="0">dead role</div></div>`);
  await wire(page, ['root'], 'onKeyDown');
  expect(await scan(page, 's')).toEqual(['s|div>div.x|dead role']);
});

test('dead_click_nearest_interactive_ancestor_counts', async ({ page }) => {
  await page.setContent(`<style>.x{cursor:pointer}</style>
    <div id="row" tabindex="0"><div class="x" role="button" tabindex="0">wired parent</div></div>
    <div id="outer" tabindex="0"><div id="mid" tabindex="0"><div class="x" role="button" tabindex="0">dead nearest parent</div></div></div>`);
  await wire(page, ['row', 'outer']);
  // The first has its handler on the nearest interactive ancestor (the `wire` helper on an interactive parent); the second's
  // nearest interactive ancestor has none, and a handler further up does not stand in for it.
  expect(await scan(page, 's')).toEqual(['s|div>div>div.x|dead nearest parent']);
});

test('dead_click_gate: every state of the window passes against scripts/dead-click.baseline', async ({ app, core }) => {
  const found: string[] = [];
  const take = async (state: string) => void found.push(...(await scan(app, state)));
  const a = agent(core, 'alpha');
  core.shell(core.project('demo'), 'one');
  await openWindow(app, {}, core);
  await app.locator('.tab').first().waitFor();
  await take('default');
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  await take('session');
  await app.locator(`.tab[data-tab="${a.id}"]`).click({ button: 'right' });
  await expect(app.getByRole('menu', { name: 'Actions' })).toBeVisible();
  await take('context-menu');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  await expect(app.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await take('palette');
  await app.keyboard.press('Escape');
  // A temporary split: ⌘D opens the chooser split beside the chat.
  await app.keyboard.press('Meta+KeyD');
  await expect(app.locator('[data-split-id]')).toHaveCount(1);
  await take('split');
  await app.locator('[data-split-id]').getByRole('button', { name: 'Close split' }).click();
  await expect(app.locator('[data-split-id]')).toHaveCount(0);
  await icon(app, 'left', 'Files').click();
  await expect(app.locator('aside.sbar[data-side="left"] .sbh b')).toHaveText('Files');
  await take('files');
  await icon(app, 'left', 'Search').click();
  await expect(app.locator('aside.sbar[data-side="left"] .sbh b')).toHaveText('Search');
  await take('search');
  await app.getByRole('button', { name: /^Settings/ }).first().click();
  const settings = app.getByRole('region', { name: 'Settings' });
  await expect(settings).toBeVisible();
  for (const page of ['Keyboard', 'Layout']) {
    await settings.getByRole('button', { name: page, exact: true }).click();
    await take(`settings-${page.toLowerCase()}`);
  }
  await app.getByRole('button', { name: 'Close Settings' }).click(); // Settings is a modal: what sits behind it cannot be clicked
  await app.getByRole('button', { name: /^Board/ }).first().click();
  await expect(app.locator('.board')).toBeVisible();
  await take('board');
  ratchet(found);
});
