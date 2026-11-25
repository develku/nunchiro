// V1A-49 QA UI bugs: one spec per ticket outcome, each red before its fix (REPORT.md has the receipts).
import type { Page } from '@playwright/test';
import { expect, goTab, openWindow, test, stripOnTop } from './fixtures';
import { closeModal } from './settings-modal';
import { chat, openChat, test as chatTest } from './fixtures/chat/harness';

test.beforeEach(({ core }) => stripOnTop(core));

const LONG = 'a-very-long-project-name-that-fills-the-whole-agents-row-for-sure';

/** A few projects with many sessions, so the lists scroll and the docks clip things at small sizes. */
function populate(core: Parameters<Parameters<typeof test>[2]>[0]['core']) {
  for (const p of ['alpha', 'beta', LONG]) for (let i = 0; i < 6; i++) core.shell(core.project(p), `s${i}`);
}

/**
 * Independent of Hints.tsx's sampling: a target is visible when any point of a 6 px grid over its on-screen part hit-tests
 * to it (or inside it). This is the definition (needs 25: anything the user can see), checked by brute force.
 */
const seen = (page: Page) =>
  page.evaluate(() => {
    const sel = 'button:not(:disabled), a[href], input:not([type=hidden]):not(:disabled), textarea:not(.xterm-helper-textarea):not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"]), .term, [data-hint-kind]';
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (el.closest('[hidden], .hints-layer, .hint-preview, .hk-board, .xterm')) continue;
      // Ticket 389: no label where a click does nothing useful: drag edges, marked duplicates, parts of a project or
      // session row, controls hidden until hover, panes and quiet controls (those wait for Shift + their kind key).
      const row = '[data-hint-kind="project"], [data-hint-kind="agent"], [data-hint-kind="session"]';
      if (el.closest('[data-hint-skip], [role="separator"]') || el.parentElement?.closest(row) || el.matches('[data-hint-kind="pane"]')) continue;
      // Ticket 408: nor on an unusable control (disabled, or marked aria-disabled) or an ended session's read-only terminal.
      if (el.closest('[aria-disabled="true"]') || el.matches('.roterm .term')) continue;
      if (el.closest('[data-hint-quiet]') && !el.matches('[data-hint-kind="tab"]')) continue;
      if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
      const [l, t, rt, b] = [Math.max(r.left, 0), Math.max(r.top, 0), Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight)];
      let hit = false;
      for (let y = t + 0.5; y < b && !hit; y += 6)
        for (let x = l + 0.5; x < rt && !hit; x += 6) {
          const top = document.elementFromPoint(x, y);
          hit = !!top && el.contains(top);
        }
      if (hit) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  });

const hintBoxes = (page: Page) =>
  page.$$eval('.hint[data-kind="element"]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { label: (e as HTMLElement).dataset.hint!, x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );

for (const size of [
  { width: 1280, height: 800 },
  { width: 800, height: 600 },
]) {
  test(`outcome 1: no two hint labels overlap and none labels a hidden target at ${size.width}x${size.height}`, async ({ app, core }) => {
    populate(core);
    await app.setViewportSize(size);
    await openWindow(app);
    await app.waitForTimeout(600); // D5b: the sidebar folds a frame or two after the window opens at this width; measure after it settles
    const visible = await seen(app);
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyF');
    await expect(app.locator('.hint[data-kind="element"]').first()).toBeVisible();
    const boxes = await hintBoxes(app);
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push(`${a.label}/${b.label}`);
      }
    expect(overlaps).toEqual([]);
    // Every label touches a target the user can see (within 1 px), so a hidden target's label cannot hide among visible ones.
    for (const b of boxes) {
      const touches = visible.some((t) => b.x < t.x + t.w + 1 && t.x < b.x + b.w + 1 && b.y < t.y + t.h + 1 && t.y < b.y + b.h + 1);
      expect(touches, `label ${b.label} touches no visible target`).toBe(true);
    }
    // Every visible target keeps a label (needs 25): none is dropped for want of a free spot.
    expect(boxes.length).toBe(visible.length);
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(size.width);
      expect(b.y + b.h).toBeLessThanOrEqual(size.height);
    }
  });
}

// Ticket 408 follow-up: the brute-force target set above skips what Hints.tsx skips (an ended session's read-only
// terminal, disabled and aria-disabled controls), so with such a screen in front every label still has its target and
// every target its label.
test('outcome 1: with a failed shell in front, the labels match the usable targets one for one', async ({ app, core }) => {
  populate(core);
  const p = core.project('demo');
  const broken = core.shell(p, 'broken', '/bin/sh', '-c', 'read x; exit 3').id;
  await openWindow(app);
  await goTab(app, core, broken);
  core.cli('session', 'send-text', broken, 'x\r'); // the shell fails with nothing on its screen
  await expect(app.locator('.roterm .term')).toBeVisible();
  // The window has taken the end in: the session header reads the front session as ended (`done`: a shell's exit code is not
  // a failure state), its tab still the selected one.
  await expect(app.locator('.shead .st')).toHaveAttribute('data-s', 'done');
  await expect(app.locator(`.tab[data-tab="${broken}"]`)).toHaveAttribute('aria-selected', 'true');
  const visible = await seen(app);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyF');
  await expect(app.locator('.hint[data-kind="element"]').first()).toBeVisible();
  const boxes = await hintBoxes(app);
  for (const b of boxes) {
    const touches = visible.some((t) => b.x < t.x + t.w + 1 && t.x < b.x + b.w + 1 && b.y < t.y + t.h + 1 && t.y < b.y + b.h + 1);
    expect(touches, `label ${b.label} touches no visible target`).toBe(true);
  }
  expect(boxes.length).toBe(visible.length);
});

test('outcome 2: the board icon toggles the board like Artifacts, Diff and Preview', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const icon = app.getByRole('button', { name: /^Board( · |$)/ });
  // The default layout may or may not carry a board: start from a shown one, then a click hides it and the next shows it again.
  if ((await app.locator('.board').count()) === 0) await icon.click();
  await expect(app.locator('.board')).toBeVisible();
  await expect(icon).toHaveAttribute('aria-pressed', 'true');
  await closeModal(app); // v25f: the Board modal covers the rail icon, so it is shut by its own close button
  await expect(app.locator('.board')).toHaveCount(0);
  await expect(icon).toHaveAttribute('aria-pressed', 'false');
  await icon.click();
  await expect(app.locator('.board')).toBeVisible();
});

const lum = (c: number[]) => {
  const [r, g, b] = c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
for (const scheme of ['light', 'dark'] as const) {
  test(`outcome 4: the zoom note reads at 4.5:1 in the ${scheme} theme`, async ({ app, core }) => {
    await app.emulateMedia({ colorScheme: scheme });
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    await app.locator('.tab').first().click();
    await app.keyboard.press('Control+Space');
    await app.keyboard.press('KeyZ');
    const note = app.locator('.zoom-note');
    await expect(note).toBeVisible();
    // Colors are read back through a canvas so rgb(), color() and named forms all resolve to bytes.
    const [fg, bg] = await note.evaluate((el) => {
      const px = (css: string) => {
        const c = document.createElement('canvas').getContext('2d')!;
        c.fillStyle = css;
        c.fillRect(0, 0, 1, 1);
        return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const s = getComputedStyle(el);
      return [px(s.color), px(s.backgroundColor)];
    });
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    expect((a + 0.05) / (b + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
}

chatTest('outcome 5: the session header holds no switch, and the notify select is whole (AGENTVIEW)', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  await openChat(page, s.id);
  await expect(chat(page, s.id)).toBeVisible();
  await expect(page.locator('.vseg')).toHaveCount(0);
  const sel = (await page.locator('.shead .qlevel').boundingBox())!;
  const head = (await page.locator('.shead').boundingBox())!;
  expect(sel.x + sel.width).toBeLessThanOrEqual(head.x + head.width);
});

// V1A-50 (carried V1A-49 review): at a narrow width the session header's text wrapped and spilled out of its 24 px
// row onto the terminal. It stays one line: the name and the details cut with an ellipsis, the notify select whole.
test('outcome 5: the session header stays one line at a narrow width', async ({ app, core }) => {
  const s = core.shell(core.project(LONG), 'a-long-session-name-for-the-header-check');
  await app.setViewportSize({ width: 800, height: 600 });
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const head = await app.locator('.shead').first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [...el.children].map((c) => {
      const r = c.getBoundingClientRect();
      const e = c as HTMLElement;
      return { tag: c.tagName, cls: c.className, inside: r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right, cut: e.scrollWidth > e.clientWidth, ellipsis: getComputedStyle(c).textOverflow === 'ellipsis' };
    });
  });
  for (const c of head) expect(c.inside, c.tag).toBe(true);
  const name = head.find((c) => c.tag === 'B')!;
  expect(name).toMatchObject({ cut: true, ellipsis: true });
  expect(head.find((c) => c.tag === 'SPAN' && (c as { cls: string }).cls === 'qlevel')!.cut).toBe(false); // needs 130: a button in a span, not a select
});

test('carried (v1a-43 review): a keyboard-focused zone shows a focus ring', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.keyboard.press('Tab'); // the last input is the keyboard, so programmatic focus counts as focus-visible
  const zone = app.locator('.lz').first();
  await zone.evaluate((el) => (el as HTMLElement).focus());
  await expect(zone).toBeFocused();
  const o = await zone.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(o.style).not.toBe('none');
  expect(o.width).toBeGreaterThan(0);
});
