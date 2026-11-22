// ticket 291 items 3-4 (needs 210): the screens the overlap check and the no-op click check both walk. The state list
// follows web/tests/dead-click.spec.ts (its steps, one self-contained `enter` per state so a click can start again from a
// fresh window), plus the two the RC2c screens got wrong: a chat whose transcript has skipped lines (the note sat over the
// mode button) and a chat with a pending decision (its "Answer in Decisions" button did nothing).
// dead-click.spec.ts is a spec file and cannot be imported from another spec, and it exports nothing, so its clickable
// test is copied into `HELPERS` below (the same definition: a pointer cursor or a background :hover rule).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, expect, rec, test as base, type ChatCore } from './fixtures/chat/harness';
import { icon } from './d5b';

export const test = base;
export { expect };

/** Installed before every page load: `window.__ux` holds the in-page helpers both specs use. */
const HELPERS = () => {
  const NATIVE = 'button, a[href], input, select, textarea, summary, label[for], option';
  const hover: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText.includes(':hover') && (r.style.background || r.style.backgroundColor)) {
        for (const sel of r.selectorText.split(',')) if (sel.includes(':hover')) hover.push(sel.replace(/:hover/g, '').trim() || '*');
      } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
    }
  };
  const scanSheets = () => {
    hover.length = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {
        // A sheet from another origin: not ours.
      }
    }
  };
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
  };
  const looksClickable = (el: Element) =>
    getComputedStyle(el).cursor === 'pointer' || hover.some((s) => { try { return el.matches(s); } catch { return false; } });
  const css = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement)
      parts.unshift(e.tagName.toLowerCase() + [...e.classList].filter((c) => !/^\d|^css-/.test(c)).map((c) => `.${c}`).join(''));
    return parts.join('>');
  };
  const label = (el: Element) => (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
  // The same clickables as the dead-click spec, minus what sits inside another clickable (the outer one answers the click).
  const clickables = () => {
    scanSheets();
    const all = Array.from(document.body.querySelectorAll('*')).filter((el) => shown(el) && looksClickable(el));
    return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
  };
  (window as unknown as Record<string, unknown>).__ux = { css, label, clickables, shown, NATIVE };
};

export type Ux = {
  clickables(): Element[];
  css(el: Element): string;
  label(el: Element): string;
  shown(el: Element): boolean;
};

/** Requests the window sends on its socket, recorded; with `guard` an answer-path request never reaches the core. */
const GUARDED = new Set(['answer', 'send_text', 'send_keys']);

export interface Ctx {
  page: Page;
  core: ChatCore;
  alpha: string; // a chat whose transcript has two lines the core skipped (the "Some lines could not be shown" note)
  beta: string; // a chat with a pending startup dialog ("Do you trust the files") (the chat's "Answer in Decisions" row)
  sent: { op: string }[];
  blocked: string[];
  http: number; // HTTP requests the page made (fetch, xhr, document)
  popups: number; // windows the page opened
  /** The core-side files a click can change (the window saves its layout and settings there): content at seed, null = absent. */
  files: Record<string, string | null>;
}

/** Two chat sessions and a shell on a fresh core, the window's socket proxied (beta shows one pending decision). */
export async function seed(page: Page, core: ChatCore, guard: boolean): Promise<Ctx> {
  const alpha = core.chat('alpha', true, false, 'ux');
  append(alpha.file, rec.user('hello'), rec.assistant('the answer'), '{"type":"nope"}', 'garbage line');
  const beta = core.chat('beta', true, false, 'ux');
  append(beta.file, rec.user('go'), rec.assistant('Let me ask.'));
  core.shell(core.project('ux'), 'one'); // ticket 570: one project, so the three tabs share a strip
  const ctx: Ctx = { page, core, alpha: alpha.id, beta: beta.id, sent: [], blocked: [], http: 0, popups: 0, files: {} };
  for (const f of ['layout.toml', 'settings.json']) ctx.files[f] = fs.existsSync(path.join(core.home, f)) ? fs.readFileSync(path.join(core.home, f), 'utf8') : null;
  page.on('request', (r) => /^(fetch|xhr|document)$/.test(r.resourceType()) && ctx.http++);
  page.on('dialog', (d) => (d.type() === 'beforeunload' || ctx.popups++, void (d.type() === 'beforeunload' ? d.accept() : d.dismiss()))); // a native confirm is an effect; leaving the page (beforeunload) must not block the next fresh start
  page.on('popup', (p) => (ctx.popups++, void p.close()));
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? [])
      if (s.id === beta.id) {
        s.pending = [{ id: `d-${s.id}`, session_id: s.id, scope: s.project, kind: 'dialog', text: 'Do you trust the files in this folder?', choices: [], observed_at: Date.now() - 5_000, actionable: true, risky: false }];
        Object.assign(s.attention, { working: true, waiting: true, stale: false, failed: false });
      }
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const m = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (m?.request) {
        ctx.sent.push(m.request);
        if (guard && GUARDED.has(m.request.op)) return void ctx.blocked.push(m.request.op);
      }
      server.send(msg);
    });
    server.onMessage((raw) => ws.send(typeof raw === 'string' && JSON.parse(raw).event === 'snapshot' ? patch(raw) : raw));
  });
  await page.addInitScript(HELPERS);
  await page.addInitScript(() => localStorage.setItem('nunchiro.layout.strip-left-chat.v1', '1'));
  return ctx;
}

/** The seeded sessions (alpha, beta, one shell): the tabs a fresh window shows. */
export const SEEDED_TABS = 3;
// An empty document on the app's origin: the window's saved state (`localStorage`, chrome/windowState.ts) is cleared here, where no app runs.
const NO_APP = '/__no-app';
const routed = new WeakSet<Page>();

/**
 * Opens the default window: the core-side layout files back as seeded, the window's saved state gone, `need` tabs showing
 * (V2.5-41). Clearing `localStorage` under a loaded app is a race: the app re-saves the tabs it restored (chrome/windowState.ts
 * `save`), and on webkit under load that write landed after `clear()` and before the next load, so a tab the last click had
 * closed came back closed (2 of 3 seeded tabs, 10 of 40 runs).
 */
export const openApp = async (c: Ctx, need = SEEDED_TABS, timeout = 5000) => {
  const T = (m: string) => process.env.NOOP_TRACE && console.log(`    openApp ${m}`);
  // A state starts from the default window: what an earlier click left open is in localStorage and in the core's layout.toml / settings.json.
  for (const [f, text] of Object.entries(c.files)) {
    const file = path.join(c.core.home, f);
    if (text === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, text);
  }
  if (!routed.has(c.page)) {
    routed.add(c.page);
    await c.page.route(`**${NO_APP}`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>no app</title>' }));
  }
  T('no-app');
  await c.page.goto(NO_APP); // leaves the app, which saves its state on the way out; nothing is left to save after the clear
  T('clear');
  // v25f: the modal an earlier click left open is kept per window in sessionStorage (chrome/Overlay.tsx): a reload reopens it, and the default window has none.
  await c.page.evaluate(() => (localStorage.clear(), sessionStorage.removeItem('nunchiro.overlay')));
  T('goto');
  await c.page.goto('/');
  T('status');
  await expect(c.page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  T('tabs');
  // At least the seeded sessions: a click in an earlier fresh start may have started one more.
  const tabs = c.page.locator('.tab[data-tab]');
  let seen = 0;
  try {
    await expect.poll(async () => (seen = await tabs.count()), { timeout }).toBeGreaterThanOrEqual(need);
  } catch {
    throw new Error(`openApp: ${seen} of ${need} seeded tabs (.tab[data-tab]) after ${timeout} ms, ${need - seen} missing; showing: ${JSON.stringify(await tabs.allInnerTexts().catch(() => []))}`);
  }
  T('done');
};
const openTab = async (c: Ctx, id: string) => {
  await openApp(c);
  await c.page.locator(`.tab[data-tab="${id}"]`).click();
  await expect(c.page.locator(`.chat[data-session="${id}"] .clist`)).toHaveAttribute('aria-busy', 'false');
};

export interface UxState {
  name: string;
  /** From a freshly loaded window (the core keeps its sessions), reaches the state. */
  enter(c: Ctx): Promise<void>;
}

export const STATES: UxState[] = [
  {
    name: 'default',
    enter: async (c) => {
      await openApp(c);
      // The window opens on a chat: wait for its first page, or the skip note appears (or not) while the scan runs.
      await c.page.locator('.chat .clist[aria-busy="false"]').first().waitFor({ timeout: 5000 }).catch(() => {});
    },
  },
  {
    name: 'session-note',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await expect(c.page.locator(`.chat[data-session="${c.alpha}"] .skipped`)).toHaveText('Some lines could not be shown');
    },
  },
  {
    name: 'session-decision',
    enter: async (c) => {
      await openTab(c, c.beta);
      await expect(c.page.locator('.shead .st')).toHaveAttribute('data-s', /wait|ask|need|attention/i);
    },
  },
  {
    name: 'decisions',
    enter: async (c) => {
      await openTab(c, c.beta);
      await icon(c.page, 'right', 'Decisions').click();
      await expect(c.page.locator('aside.sbar[data-side="right"]')).toHaveAttribute('data-widget', 'decisions');
    },
  },
  {
    name: 'context-menu',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await c.page.locator(`.tab[data-tab="${c.alpha}"]`).click({ button: 'right' });
      await expect(c.page.getByRole('menu', { name: 'Actions' })).toBeVisible();
    },
  },
  {
    name: 'palette',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await c.page.keyboard.press('Meta+KeyK');
      await expect(c.page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    },
  },
  {
    name: 'split',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await c.page.keyboard.press('Meta+KeyD');
      await expect(c.page.locator('[data-split-id]')).toHaveCount(1);
    },
  },
  {
    // Look 1117 v4f C S2-2: the composer card ran under the Browser pane and over its page.
    name: 'browser',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await icon(c.page, 'right', 'Browser').click();
      await expect(c.page.locator('[data-side-pane]:not([hidden])')).toBeVisible();
    },
  },
  {
    name: 'files',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await icon(c.page, 'left', 'Files').click();
      await expect(c.page.locator('aside.sbar[data-side="left"] .sbh b')).toHaveText('Files');
    },
  },
  {
    name: 'search',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await icon(c.page, 'left', 'Search').click();
      await expect(c.page.locator('aside.sbar[data-side="left"] .sbh b')).toHaveText('Search');
    },
  },
  ...['Keyboard', 'Layout'].map((name) => ({
    name: `settings-${name.toLowerCase()}`,
    enter: async (c: Ctx) => {
      await openTab(c, c.alpha);
      await c.page.getByRole('button', { name: /^Settings/ }).first().click();
      const settings = c.page.getByRole('region', { name: 'Settings' });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name, exact: true }).click();
    },
  })),
  {
    name: 'board',
    enter: async (c) => {
      await openTab(c, c.alpha);
      await c.page.getByRole('button', { name: /^Board/ }).first().click();
      await expect(c.page.locator('.board')).toBeVisible();
    },
  },
];
