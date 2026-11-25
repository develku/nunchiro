// V1B-44 (design QA M3): the artifact frame shows where keyboard focus is. The sandboxed iframe's own outline is
// never drawn (focus sits in the page inside it), so ArtifactFrame sets `data-focus` on the wrapper in the parent page
// (option A): on the parent window's focus and blur it checks `document.activeElement` against the iframe element.
// The frame, its sandbox and the CSP are untouched, and sandbox.css draws the ring from the attribute. Real core and
// fake agent as in artifacts.spec.ts; the frame is the plain `ok/page.html` fixture, which has no controls of its
// own. Playwright drives Chromium and WebKit, not the Tauri WKWebView.
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { contrast } from '../src/themes/derive';
import { windowTokens } from './window-tokens';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { REPO } from './fixtures';
import { installHost, showFrame } from './fixtures/artifacts/cards/host';
import { append, chat, expect, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { artifactServer } from './sandbox-server';

type Art = Awaited<ReturnType<typeof artifactServer>>;
const test = chatTest.extend<object, { art: Art }>({
  art: [
    async ({}, use) => {
      const art = await artifactServer({});
      await use(art);
      await art.close();
    },
    { scope: 'worker' },
  ],
});

const BUILT_IN = [LIGHT_PICK, DARK_PICK, ...Object.entries(THEMES).map(([name, text]) => ({ name, colors: parseGhostty(text) }))];
const hex = (rgb: string) => `#${rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;

/** A session whose chat holds one HTML artifact card; returns the card. */
async function cardWithFrame(page: Page, chatCore: { chat: () => { id: string; cwd: string; file: string } }, art: Art) {
  await installHost(page, art, []);
  const s = chatCore.chat();
  const full = path.join(s.cwd, 'site/index.html');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, fs.readFileSync(path.join(REPO, 'web/tests/fixtures/artifacts/ok/page.html'), 'utf8'));
  append(s.file, [
    rec.user('page'),
    rec.use('w1', 'Write', { file_path: full, content: '' }),
    rec.result('w1', `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: '', structuredPatch: [] } }),
    rec.assistant('done'),
  ]);
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.acard[data-path="site/index.html"]');
  await expect(card).toHaveAttribute('data-state', 'ready');
  await showFrame(card);
  await expect(card.frameLocator('iframe').locator('body')).toContainText('tall page');
  return card;
}

/** The Preview of the same artifact, opened from the card's Open chip. */
async function previewFrame(page: Page, card: Locator) {
  await card.getByRole('button', { name: 'Open' }).click();
  const pv = page.locator('.preview .pv-frame');
  await expect(pv.frameLocator('iframe').locator('body')).toContainText('tall page');
  return pv;
}

/** Tab, or Option+Tab on WebKit, where plain Tab skips buttons (Safari's default); the frame and wrapper take either. */
const tab = (page: Page, back = false) =>
  page.keyboard.press(`${back ? 'Shift+' : ''}${page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+' : ''}Tab`);

/** Tab until the iframe holds focus (the wrapper is the frame's own first stop). */
async function tabIntoFrame(page: Page, wrapper: Locator) {
  await wrapper.focus();
  for (let i = 0; i < 6; i++) {
    await tab(page);
    if (await wrapper.locator('iframe').evaluate((f) => document.activeElement === f)) return i + 1;
  }
  throw new Error('Tab never reached the iframe');
}

/** The wrapper's outline as drawn, and the colour of the opaque surface behind it. */
const ring = (wrapper: Locator) =>
  wrapper.evaluate((w) => {
    const behind = (e: Element | null): string => {
      for (; e; e = e.parentElement) {
        const b = getComputedStyle(e).backgroundColor;
        if (!/rgba\(.*, 0\)$|transparent/.test(b)) return b;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const cs = getComputedStyle(w);
    return { width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset, color: cs.outlineColor, behind: behind(w.parentElement) };
  });

const setTokens = (page: Page, tokens: Record<string, string>) =>
  page.evaluate((t) => {
    for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(k, v);
  }, tokens);

async function expectRingInLightAndDark(page: Page, wrapper: Locator) {
  for (const t of [LIGHT_PICK, DARK_PICK]) {
    await setTokens(page, windowTokens(t.colors));
    const r = await ring(wrapper);
    expect([r.width, r.style, r.offset], `${t.name} outline`).toEqual(['2px', 'solid', '2px']);
    expect(contrast(hex(r.color), hex(r.behind)), `${t.name} ring ${r.color} on ${r.behind}`).toBeGreaterThanOrEqual(3);
  }
}

test('artifact_frame_focus_ring', async ({ page, chatCore, art }) => {
  const card = await cardWithFrame(page, chatCore, art);
  const wrapper = card.locator('.artifact-frame');
  await wrapper.focus();
  await tab(page);
  await expect(card.getByRole('button', { name: 'Fold the preview' })).toBeFocused(); // ticket 1057's chevron
  await tab(page);
  await expect(card.getByRole('button', { name: 'Open' })).toBeFocused();
  await tab(page);
  await expect(card.getByRole('button', { name: 'Network off' })).toBeFocused();
  await tab(page);
  expect(await wrapper.locator('iframe').evaluate((f) => document.activeElement === f)).toBe(true);
  await expectRingInLightAndDark(page, wrapper);
});

test('artifact_frame_shows_focus_ring_in_preview', async ({ page, chatCore, art }) => {
  const pv = await previewFrame(page, await cardWithFrame(page, chatCore, art));
  const wrapper = pv.locator('.artifact-frame');
  await tabIntoFrame(page, wrapper);
  await expectRingInLightAndDark(page, wrapper);
});

test('artifact_frame_ring_all_built_in_themes', async ({ page, chatCore, art }) => {
  const wrapper = (await cardWithFrame(page, chatCore, art)).locator('.artifact-frame');
  await tabIntoFrame(page, wrapper);
  const low: string[] = [];
  for (const t of BUILT_IN) {
    await setTokens(page, windowTokens(t.colors));
    const r = await ring(wrapper);
    if (r.style !== 'solid' || r.width !== '2px') low.push(`${t.name}: no ring (${r.width} ${r.style})`);
    const ratio = contrast(hex(r.color), hex(r.behind));
    if (ratio < 3) low.push(`${t.name}: ${hex(r.color)} on ${hex(r.behind)} = ${ratio.toFixed(2)}:1`);
  }
  expect(BUILT_IN.length).toBe(Object.keys(THEMES).length + 2);
  expect(low).toEqual([]);
});

test('artifact_frame_focus_clears', async ({ page, chatCore, art }) => {
  const card = await cardWithFrame(page, chatCore, art);
  const wrapper = card.locator('.artifact-frame');
  const framed = () => ring(wrapper).then((r) => r.style === 'solid' && r.width === '2px' && r.offset === '2px');
  await tabIntoFrame(page, wrapper);
  expect(await framed()).toBe(true);
  // Tab out: the ring goes. Shift+Tab back in: it returns.
  await tab(page);
  expect(await wrapper.locator('iframe').evaluate((f) => document.activeElement === f)).toBe(false);
  expect(await framed()).toBe(false);
  await tab(page, true);
  expect(await framed()).toBe(true);
  // Shift+Tab onto Network off: the chip keeps its own single ring and the wrapper draws none.
  await tab(page, true);
  const chip = card.getByRole('button', { name: 'Network off' });
  await expect(chip).toBeFocused();
  expect(await framed()).toBe(false);
  expect(await chip.evaluate((c) => getComputedStyle(c).outlineStyle)).toBe('solid');
  await tab(page, true);
  await expect(card.getByRole('button', { name: 'Open' })).toBeFocused();
  expect(await framed()).toBe(false);
  // Click elsewhere: the ring goes.
  await tabIntoFrame(page, wrapper);
  expect(await framed()).toBe(true);
  await page.locator('.cbox textarea').click();
  expect(await framed()).toBe(false);
  // The frame removed while it holds focus (Network off remounts the iframe): the ring does not outlive it.
  await tabIntoFrame(page, wrapper);
  expect(await framed()).toBe(true);
  await card.getByRole('button', { name: 'Network off' }).evaluate((c) => (c as HTMLElement).click());
  await expect(wrapper).toHaveAttribute('data-net', 'on');
  await expect(wrapper).not.toHaveAttribute('data-focus');
  expect(await framed()).toBe(false);
});

test('artifact_frame_focus_not_trapped', async ({ page, chatCore, art }) => {
  // The plain fixture page has no controls and no key handlers; a page that traps Tab itself is that page's behaviour.
  const wrapper = (await cardWithFrame(page, chatCore, art)).locator('.artifact-frame');
  await tabIntoFrame(page, wrapper);
  const outside = () => page.evaluate(() => (document.activeElement as HTMLElement).tagName + '.' + (document.activeElement as HTMLElement).className);
  await tab(page);
  const next = await outside();
  expect(next).not.toMatch(/^IFRAME/);
  await tab(page, true);
  expect(await wrapper.locator('iframe').evaluate((f) => document.activeElement === f)).toBe(true);
  await tab(page, true);
  await expect(wrapper.getByRole('button', { name: 'Network off' })).toBeFocused();
  await tab(page);
  await tab(page);
  expect(await outside()).toBe(next);
});

test('artifact_frame_ring_adds_no_tab_stop_and_moves_nothing', async ({ page, chatCore, art }) => {
  const card = await cardWithFrame(page, chatCore, art);
  const wrapper = card.locator('.artifact-frame');
  const boxes = () =>
    card.evaluate((c) => {
      const r = (e: Element | null) => (e ? JSON.stringify(e.getBoundingClientRect()) : '');
      const row = c.closest('.crow');
      return [c, c.querySelector('.artifact-frame'), c.querySelector('iframe'), c.querySelector('.af-bar'), row?.nextElementSibling ?? null, row?.previousElementSibling ?? null].map(r);
    });
  const stops = () =>
    card.evaluate((c) => [...c.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input,select,textarea,iframe,[tabindex]')].filter((e) => e.tabIndex >= 0).length);
  const before = { boxes: await boxes(), stops: await stops() };
  await tabIntoFrame(page, wrapper);
  expect(await ring(wrapper).then((r) => r.style)).toBe('solid');
  expect({ boxes: await boxes(), stops: await stops() }).toEqual(before);
  // The wrapper (tabindex 0), the fold chevron (ticket 1057), Open, Network off and the iframe: no sixth stop for the ring.
  expect(before.stops).toBe(5);
  // All four sides of the outline (outline width + offset = 4px) lie inside every clipping ancestor and the window.
  const clipped = await wrapper.evaluate((w) => {
    const r = w.getBoundingClientRect();
    const out = { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 };
    const bad: string[] = [];
    const inside = (name: string, b: { left: number; top: number; right: number; bottom: number }) => {
      if (out.left < b.left || out.top < b.top || out.right > b.right || out.bottom > b.bottom) bad.push(name);
    };
    inside('window', { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    for (let e = w.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = e.getBoundingClientRect();
      inside(`${e.tagName}.${e.className}`, { left: b.left + e.clientLeft, top: b.top + e.clientTop, right: b.left + e.clientLeft + e.clientWidth, bottom: b.top + e.clientTop + e.clientHeight });
    }
    return bad;
  });
  expect(clipped).toEqual([]);
});

test('artifact_frame_ring_is_not_clipped_in_preview', async ({ page, chatCore, art }) => {
  const wrapper = (await previewFrame(page, await cardWithFrame(page, chatCore, art))).locator('.artifact-frame');
  await tabIntoFrame(page, wrapper);
  const clipped = await wrapper.evaluate((w) => {
    const r = w.getBoundingClientRect();
    const out = { left: r.left - 4, top: r.top - 4, right: r.right + 4, bottom: r.bottom + 4 };
    const bad: string[] = [];
    for (let e = w.parentElement; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = e.getBoundingClientRect();
      const box = { left: b.left + e.clientLeft, top: b.top + e.clientTop, right: b.left + e.clientLeft + e.clientWidth, bottom: b.top + e.clientTop + e.clientHeight };
      if (out.left < box.left || out.top < box.top || out.right > box.right || out.bottom > box.bottom) bad.push(`${e.tagName}.${e.className}`);
    }
    if (out.left < 0 || out.top < 0 || out.right > innerWidth || out.bottom > innerHeight) bad.push('window');
    return bad;
  });
  expect(clipped).toEqual([]);
});

// `message` listeners the window registers while a card with a frame mounts and opens in Preview (two frames).
// The total, 4 (stacks logged once, ticket 79): the frame's message handler, one per mount (`ArtifactFrame.tsx:123`; default
// openLink hoisted, so parent renders no longer re-register), plus two from the xterm bundles, which register VS Code's
// async-work scheduler on import (`@xterm/xterm` and `@xterm/addon-search`, loaded by `Terminal.tsx`). `WebWidget.tsx:163`
// registers one more only while a web widget is mounted, which this test does not do. A new listener (a new postMessage
// path into the window) must fail here. Only `window.addEventListener('message', ...)` calls are counted, not `onmessage` or listeners inside the frame. (It was 7
// while the default openLink was an inline function: the effect re-ran on every parent render.)
const MESSAGE_LISTENERS = 4;

test('artifact_frame_boundary_unchanged', async ({ page, chatCore, art }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __messageListeners: number };
    w.__messageListeners = 0;
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'message') w.__messageListeners++;
      return (add as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
  });
  const card = await cardWithFrame(page, chatCore, art);
  const pv = await previewFrame(page, card);
  for (const f of [card.locator('iframe'), pv.locator('iframe')]) {
    const attrs = await f.evaluate((e) => ({ sandbox: e.getAttribute('sandbox'), allow: e.getAttribute('allow'), referrerpolicy: e.getAttribute('referrerpolicy'), srcdoc: e.getAttribute('srcdoc') }));
    expect(attrs).toEqual({ sandbox: 'allow-scripts', allow: null, referrerpolicy: 'no-referrer', srcdoc: null });
  }
  const count = () => page.evaluate(() => (window as unknown as { __messageListeners: number }).__messageListeners);
  const before = await count();
  expect(before).toBe(MESSAGE_LISTENERS);
  // Render independence: more renders of the window (the left sidebar collapsing and opening again) add no registration.
  const tree = page.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Tree' });
  await tree.click();
  await expect(page.locator('aside.sbar[data-side="left"]')).toHaveCount(0);
  await tree.click();
  await expect(page.locator('aside.sbar[data-side="left"]')).toHaveCount(1);
  expect(await count()).toBe(before);
  expect(await count()).toBe(MESSAGE_LISTENERS);
});
