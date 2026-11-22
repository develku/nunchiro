// needs 121 (CLAUDEFEEL composer): the bottom row keeps its controls, order and text; at a narrow composer the model and
// effort picker and the permission chip give way (ellipsis, full text in the tooltip) and never overprint a neighbour.
// Finding F1/S1 of the whole-app evaluator (74f3a340): "effort default" overprinted "Mode" with the side pane open.
import type { Locator, Page } from '@playwright/test';
import { icon } from './d5b';
import { append, expect, openChat, rec, test, type ChatCore } from './fixtures/chat/harness';

/** The widest words the row can carry: model "Opus", effort "xhigh", the longest permission mode, a known context fill. */
async function wide(page: Page, mode: () => string = () => 'accept edits') {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.request?.op === 'session_context') ws.send(JSON.stringify({ id: frame.id, response: { Ok: { type: 'session_context', used: 124000, window: 200000 } } }));
      else server.send(m);
    });
    server.onMessage((m) => {
      const frame = typeof m === 'string' ? JSON.parse(m) : null;
      if (frame?.event !== 'snapshot') return ws.send(m);
      for (const s of frame.sessions) Object.assign(s, { model: 'opus', effort: 'xhigh', permission_mode: mode(), attention: { ...s.attention, working: false } }); // idle: a working or blocked picker shows its refusal as the tooltip (cf5-side-chat pin)
      ws.send(JSON.stringify(frame));
    });
  });
}

const footer = (page: Page) => {
  const row = page.locator('.composer .chips');
  return {
    model: row.locator('[data-picker="model"]'),
    effort: row.locator('[data-picker="effort"]'),
    perm: row.getByRole('button', { name: 'Permission mode' }),
    ring: row.locator('.context-ring'),
    send: row.locator('.send'),
  };
};
const box = async (l: Locator) => (await l.boundingBox())!;
const meet = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function open(page: Page, core: ChatCore) {
  // A turn in the transcript keeps the composer in its own zone (an empty chat seats it in the empty block, v25-empty).
  const s = core.chat('footer');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await wide(page);
  await openChat(page, s.id);
  await icon(page, 'right', 'Terminal').click(); // the side pane open, as in the evaluator's shot
  await expect(page.locator('[data-side-pane]:not([hidden])')).toBeVisible();
  const f = footer(page);
  for (const l of Object.values(f)) await expect(l).toBeVisible();
  return f;
}

for (const width of [null, 760, 480, 320] as const) {
  test(`composer_footer_no_overlap (${width ?? 'as laid out'}): picker, permission chip, ring and send never intersect; ring and send keep their size`, async ({ page, chatCore }) => {
    const f = await open(page, chatCore);
    const [ring0, send0] = [await box(f.ring), await box(f.send)];
    if (width) await page.addStyleTag({ content: `[data-zone-id="composer"] { flex: none !important; width: ${width}px !important; max-width: ${width}px !important; }` });
    const zone = await box(page.locator('[data-zone-id="composer"]'));
    if (width) expect(Math.round(zone.width)).toBe(width);
    const boxes = { model: await box(f.model), effort: await box(f.effort), perm: await box(f.perm), ring: await box(f.ring), send: await box(f.send) };
    const names = Object.keys(boxes) as (keyof typeof boxes)[];
    for (const [i, a] of names.entries())
      for (const b of names.slice(i + 1)) expect(meet(boxes[a], boxes[b]), `${a} ${JSON.stringify(boxes[a])} meets ${b} ${JSON.stringify(boxes[b])}`).toBe(false);
    expect([boxes.ring.width, boxes.ring.height]).toEqual([ring0.width, ring0.height]);
    expect([boxes.send.width, boxes.send.height]).toEqual([send0.width, send0.height]);
    // Nothing paints outside its own box: a label wider than its chip is clipped, not drawn over the next control.
    for (const l of [f.model, f.effort, f.perm]) expect(await l.evaluate((e) => getComputedStyle(e).overflow)).toBe('hidden');
  });
}

// Ticket 381: the row's fill depends on the project name and fonts, so one width can miss the break: walk every composer width with both labels.
test('composer_chip_words_never_change_the_row_at_any_width', async ({ page, chatCore }) => {
  await wide(page, () => 'auto');
  await openChat(page, chatCore.chat('footer').id);
  await expect(footer(page).perm).toHaveText(/Auto/);
  const { moved, clipped } = await page.evaluate(() => {
    const cbox = document.querySelector<HTMLElement>('.cbox')!;
    const words = document.querySelector('.composer .perm .pm-text')!;
    const send = document.querySelector('.composer .chips .send')!;
    const at = (text: string) => {
      words.textContent = text;
      const b = cbox.getBoundingClientRect();
      return `${b.height}/${send.getBoundingClientRect().y - b.y}`;
    };
    const out: string[] = [];
    // Look v20 (Q5): the words stay whole (no ellipsis), so below the width that holds the longest mode on one line the row wraps;
    // the walk covers the widths where both labels fit one line (the whole-word rule is layout-clip-languages.spec.ts).
    for (let w = 720; w >= 600; w -= 2) {
      cbox.style.cssText = `width:${w}px;max-width:${w}px`;
      const [a, b] = [at('Auto'), at('Bypass permissions')];
      if (a !== b) out.push(`${w}px: ${a} vs ${b}`);
    }
    // A wide composer has room for the whole label. Look 1117 v3: at 700 px the model and effort chips keep their words (B8),
    // so the longest mode may be cut there (its full text is the tooltip); the row still holds one line.
    cbox.style.cssText = 'width:760px;max-width:760px';
    words.textContent = 'Bypass permissions';
    return { moved: out, clipped: words.scrollWidth > words.clientWidth };
  });
  expect(moved).toEqual([]);
  expect(clipped).toBe(false);
});

test('composer_footer_tooltips: the picker chips and the permission chip carry their full text in the tooltip', async ({ page, chatCore }) => {
  const f = await open(page, chatCore);
  await expect(f.model).toHaveAttribute('title', /Claude · Opus/);
  await expect(f.effort).toHaveAttribute('title', /effort xHigh/);
  await expect(f.perm).toHaveAttribute('title', /Accept edits/);
  await expect(f.perm).toHaveAccessibleName('Permission mode · Accept edits'); // look 1117 v4 B S3-4: the name says the mode, as the model chip's does
  // The visible text stays as the approved draft has it (needs 121).
  await expect(f.model).toHaveText('Claude · Opus');
  await expect(f.effort).toHaveText('effort xHigh');
  await expect(f.perm).toHaveText(/Accept edits/);
});

// B8, es1 (ticket 991, look 1117): with the Diff pane open the chips were cut to "de", "Claud…", "eff…". Wave 8: a chip
// shortens in place first, never below about eight characters (its full text is the tooltip); a really narrow composer
// wraps whole chips instead.
for (const width of [600, 520, 460] as const) {
  test(`composer_chips_readable_when_narrow (${width}px): no chip is cut below about eight characters (B8, es1)`, async ({ page, chatCore }) => {
    const f = await open(page, chatCore);
    await page.addStyleTag({ content: `[data-zone-id="composer"] { flex: none !important; width: ${width}px !important; max-width: ${width}px !important; }` });
    // Polled: an open side pane keeps the card beside it (--pane-room), set again on the next frame after the zone narrows.
    const cut = () => page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.composer .chips .pk-text, .composer .chips > .chip')]
        .filter((e) => {
          const ch = parseFloat(getComputedStyle(e).fontSize) * 0.55;
          return e.scrollWidth > e.clientWidth + 1 && e.clientWidth < 7 * ch; // seven characters and the ellipsis
        })
        .map((e) => `${e.textContent} ${e.clientWidth}/${e.scrollWidth}`),
    );
    await expect.poll(cut).toEqual([]);
    await expect(f.send).toBeVisible();
  });
}

// Wave 8 (answer-strip "off"): opening or closing a side pane at the usual window widths leaves the composer's height alone,
// so the terminal above it keeps its rows.
for (const vw of [1440, 1280] as const)
  test(`composer_height_holds_when_a_side_pane_toggles (${vw})`, async ({ page, chatCore }) => {
    await page.setViewportSize({ width: vw, height: 900 });
    await wide(page);
    const s = chatCore.chat('footer');
    append(s.file, rec.user('hi'), rec.assistant('ok'));
    await openChat(page, s.id);
    const cbox = page.locator('.composer .cbox');
    await expect(footer(page).send).toBeVisible();
    const h0 = (await box(cbox)).height;
    await icon(page, 'right', 'Decisions').click();
    await expect(page.locator('aside.sbar[data-side="right"]')).toBeVisible();
    expect((await box(cbox)).height).toBe(h0);
    await icon(page, 'right', 'Decisions').click();
    await expect.poll(async () => (await box(cbox)).height).toBe(h0);
  });

// Look 1117 v3 (item 11): at full width the chips that fit stay on one line; the permission chip never sits alone below.
test('composer_chips_one_line_when_they_fit', async ({ page, chatCore }) => {
  await wide(page, () => 'auto');
  await openChat(page, chatCore.chat('footer').id);
  await expect(footer(page).perm).toHaveText(/Auto/);
  await page.locator('.cbox').evaluate((e) => (e.style.cssText = 'width:700px;max-width:700px'));
  const f = footer(page);
  const ys = await Promise.all([f.model, f.effort, f.perm, f.send].map(async (l) => Math.round((await box(l)).y + (await box(l)).height / 2)));
  expect(new Set(ys.map((y) => Math.round(y / 6))).size, JSON.stringify(ys)).toBe(1);
});

// Look 1117 v4f C S2-2: with the Browser pane open at 1440 px the composer card ran under the pane, over its page.
test('composer_stays_beside_the_browser_pane (C S2-2): at 1440 px the card ends where the chat column ends', async ({ page, chatCore }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const s = chatCore.chat('footer');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await wide(page);
  await openChat(page, s.id);
  // The look had the Tree open beside the chat.
  if (!(await page.locator('aside.sbar[data-side="left"]').isVisible())) await icon(page, 'left', 'Tree').click();
  await expect(page.locator('aside.sbar[data-side="left"]')).toBeVisible();
  await icon(page, 'right', 'Browser').click();
  const side = page.locator('[data-side-pane]:not([hidden])');
  await expect(side).toBeVisible();
  const cbox = page.locator('.composer:not([data-pinned]) .cbox');
  await expect.poll(async () => Math.round((await box(cbox)).x + (await box(cbox)).width) <= Math.round((await box(side)).x)).toBe(true);
  // And its chips keep one line.
  const f = footer(page);
  const ys = await Promise.all([f.model, f.perm, f.send].map(async (l) => Math.round(((await box(l)).y + (await box(l)).height / 2) / 6)));
  expect(new Set(ys).size).toBe(1);
});

// Look 1117 v5 (C S3-2): a narrow composer cut the model chip at its end ("Claude · …"), so the model name was what went.
// The agent word gives way first; the model name stays whole while the chip has room for it.
test('narrow_model_chip_keeps_the_model_name', async ({ page, chatCore }) => {
  const f = await open(page, chatCore);
  await page.addStyleTag({ content: `[data-zone-id="composer"] { flex: none !important; width: 520px !important; max-width: 520px !important; }` });
  await expect(f.model).toBeVisible();
  // Polled: the row settles once its last chip is drawn (w25-p: read on the first frame under load, the agent word still showed).
  await expect.poll(() => f.model.evaluate((chip) => {
    const n = chip.querySelector<HTMLElement>('.pk-name')!;
    const a = chip.querySelector<HTMLElement>('.pk-agent');
    // Look 1117 v6r: it gives way whole (below the one line its box shows), never cut mid-letter against the name.
    // Look 1117 v11 C-NC14: in a narrow composer it goes from the layout too, so it leaves no empty room in the chip.
    return { name: n && n.scrollWidth <= n.clientWidth + 1 ? n.textContent : null, agentGone: !!a && !a.getClientRects().length };
  })).toEqual({ name: 'Opus', agentGone: true }); // the chip is narrow here: the agent word gave way
});

// Look 1117 v6r (C S3-2): at a centre of about 320 pt the model chip read "Claud(Haiku 5…" in Spanish (the agent word was
// cut mid-letter against the model's name) and the folder chip "demo-shop / mair" in Japanese (cut, no ellipsis). A text of
// the row is whole, out of view whole, or ends in an ellipsis; no two texts share pixels. A layout rule, so every language.
const cuts = (page: Page) =>
  page.locator('.composer .chips').evaluate((row) => {
    const out: string[] = [];
    const seen: { text: string; r: DOMRect }[] = [];
    const walk = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.textContent!.trim();
      const own = n.parentElement!;
      if (!text || own.closest('.sr, [hidden], [role="menu"]')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      let r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // The part of the text its clipping ancestors leave in view.
      let [left, right, top, bottom] = [r.left, r.right, r.top, r.bottom];
      let cutBy: Element | null = null;
      for (let e: Element | null = own; e && e !== row.parentElement; e = e.parentElement) {
        if (getComputedStyle(e).overflowX === 'visible') continue;
        const c = e.getBoundingClientRect();
        if (c.right < right - 0.5 || c.left > left + 0.5 || c.bottom < bottom - 0.5 || c.top > top + 0.5) cutBy ??= e;
        [left, right, top, bottom] = [Math.max(left, c.left), Math.min(right, c.right), Math.max(top, c.top), Math.min(bottom, c.bottom)];
      }
      if (right - left <= 0.5 || bottom - top <= 0.5) continue; // out of view whole
      const cs = getComputedStyle(own);
      // An ellipsis is drawn only by the block that holds the text itself (not by a flex container around it).
      if (cutBy && !(cutBy === own && cs.textOverflow === 'ellipsis' && !/flex|grid/.test(cs.display))) out.push(`"${text}" is cut with no ellipsis`);
      r = new DOMRect(left, top, right - left, bottom - top);
      for (const o of seen) if (o.r.left < r.right - 0.5 && r.left < o.r.right - 0.5 && o.r.top < r.bottom - 0.5 && r.top < o.r.bottom - 0.5) out.push(`"${text}" is drawn over "${o.text}"`);
      seen.push({ text, r });
    }
    return out;
  });
for (const lang of ['en', 'es', 'ja', 'ko'] as const)
  test(`composer_chip_text_is_whole_gone_or_ends_in_an_ellipsis (${lang}): at every narrow width`, async ({ page, chatCore }) => {
    const f = await open(page, chatCore); // opened in English (the helpers' names), then the window's language changes
    await page.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), lang);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(f.model).toBeVisible();
    await expect(f.model.locator('.pk-agent')).toHaveText(/\S/);
    const bad: string[] = [];
    for (let width = 560; width >= 300; width -= 4) {
      await page.locator('[data-zone-id="composer"]').evaluate((e, w) => (e.style.cssText = `flex:none;width:${w}px;max-width:${w}px`), width);
      for (const line of await cuts(page)) bad.push(`${width}px: ${line}`);
    }
    expect(bad).toEqual([]);
  });

// Look v18 A-O1: at a composer about 466 pt wide Send wrapped onto a second line alone and left an empty band. The mode
// chip, the ring and Send wrap as one unit, so Send's line always holds another control.
test('composer_send_never_wraps_alone: at every narrow width Send shares its line', async ({ page, chatCore }) => {
  await page.setViewportSize({ width: 860, height: 800 });
  await wide(page, () => 'auto');
  const s = chatCore.chat('demo-shop');
  append(s.file, rec.user('hi'), rec.assistant('ok'));
  await openChat(page, s.id);
  await expect(footer(page).send).toBeVisible();
  const alone = await page.evaluate(() => {
    const cbox = document.querySelector<HTMLElement>('.cbox')!;
    const send = document.querySelector<HTMLElement>('.composer .chips .send')!;
    const mid = (e: Element) => { const r = e.getBoundingClientRect(); return r.y + r.height / 2; };
    const out: number[] = [];
    for (let w = 560; w >= 400; w -= 2) {
      cbox.style.cssText = `width:${w}px;max-width:${w}px`;
      const others = [...document.querySelectorAll('.composer .chips button, .composer .chips .chip')].filter((e) => e !== send && e.getBoundingClientRect().width > 0);
      if (!others.some((e) => Math.abs(mid(e) - mid(send)) < 8)) out.push(w);
    }
    return out;
  });
  expect(alone).toEqual([]);
});
