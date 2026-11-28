// Design book, cards, floating layers, dialogs and notes: the docked permission card is a solid raised card (never glass)
// that swells; the question and Outbox cards wear the same ring, still; menu rows are 26 with radius 6; dialogs radius 14;
// the command palette radius 12; the toast a solid raised pill; the composer radius 14. Real core, fake agent; the
// pending items and the Outbox card are put into the snapshot frames here and never sent on.
// The @shots tests (PW_OPT_IN=shots ... --project shots) take the pictures to compare with the book. SHOTS_OUT names the
// folder, SHOTS_TAG the prefix.
import path from 'node:path';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import { THEMES } from '../src/themes/catalog/catalog.gen';
import { parseGhostty } from '../src/themes/ghostty';
import { DARK_PICK, LIGHT_PICK } from '../src/themes/nunchiro';
import { expect, openWindow, test, type Core } from './fixtures';

async function wire(page: Page) {
  const st = { items: {} as Record<string, unknown[]>, owner: [] as unknown[], push: () => {} };
  const sockets: WebSocketRoute[] = [];
  let last = '';
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) if (st.items[s.id]) s.pending = st.items[s.id];
    msg.owner_decisions = [...(msg.owner_decisions ?? []), ...st.owner];
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'answer') return ws.send(JSON.stringify({ id: f.id, response: { Ok: 'Ack' } }));
      server.send(m);
    });
    server.onMessage((m) => (typeof m === 'string' && m.includes('"event":"snapshot"') ? ws.send(patch((last = m))) : ws.send(m)));
  });
  st.push = () => {
    if (last) for (const ws of sockets) ws.send(patch(last));
  };
  return st;
}

const ask = (session: string, id: string, kind: string, text: string, labels: string[]) => ({
  id,
  session_id: session,
  scope: 'x',
  kind,
  text,
  choices: labels.map((label, i) => ({ label, keys: [String(i + 1)] })),
  sources: ['screen'],
  observed_at: Date.now(),
  actionable: true,
  reconciled: true,
  risky: false,
});
const PERM = (s: string) => ask(s, 'p1', 'permission', 'Bash command\n\n  pnpm test\n\nDo you want to proceed?', ['Yes', 'No']);
const QUEST = (s: string) => ask(s, 'q1', 'question', 'Which login flow should the test cover?\n\n❯ 1. Email and password\n  2. GitHub sign-in\n  3. Both\n\nEnter to select · Esc to cancel', ['Email and password', 'GitHub sign-in', 'Both']);
const OUTBOX = (s: string) => ({
  id: 'obx-1d',
  session_id: s,
  scope: 'owner',
  kind: 'owner',
  text: 'Mail to dana@example.com',
  choices: [],
  observed_at: Date.now() - 60_000,
  actionable: true,
  owner: { type: 'outward', tool: 'mcp__gmail__send_message', args: { to: ['dana@example.com'], subject: 'Re: Thursday review', body: "Thanks, Thursday at 10 works. I'll bring the login test results." }, from: 'Chief', hash: 'h' },
});

/** A session in front with the given pending items (and Outbox cards) docked above its composer. */
async function front(app: Page, core: Core, items: (s: string) => unknown[], owner: (s: string) => unknown[] = () => []) {
  const a = core.agent(core.project('agents'), 'a', 'never-created');
  const st = await wire(app);
  await openWindow(app, {}, core);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await expect(app.locator(`.chat[data-session="${a.id}"]`)).toBeVisible();
  st.items[a.id] = items(a.id);
  st.owner = owner(a.id);
  st.push();
  return a;
}
const css = (l: Locator, ...props: string[]) => l.evaluate((e, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(e).getPropertyValue(p)])), props);
/** A role's colour as the browser resolves it (rgb), from a probe on the page. */
const role = (app: Page, name: string) =>
  app.evaluate((n) => {
    const p = document.body.appendChild(document.createElement('i'));
    p.style.background = `var(${n})`;
    const v = getComputedStyle(p).backgroundColor;
    p.remove();
    return v;
  }, name);
const docked = (app: Page) => app.locator('.composer > .dock .deccard.docked');
const outbox = (app: Page) => app.locator('.composer > .dock .obx');

test('docked_permission_card_is_solid_and_swells: --raised, radius 12, no glass, the warm ring breathing (design book cards)', async ({ app, core }) => {
  await front(app, core, (s) => [PERM(s)]);
  await expect(docked(app).locator('.dc-item[data-item="p1"]')).toHaveCount(1);
  const c = await css(docked(app), 'background-color', 'background-image', 'backdrop-filter', 'border-top-left-radius', 'animation-name', 'box-shadow');
  expect(c['background-color']).toBe(await role(app, '--raised'));
  expect(c['background-image']).toBe('none');
  expect(c['backdrop-filter']).toBe('none');
  expect(c['border-top-left-radius']).toBe('12px');
  expect(c['animation-name']).toBe('swell');
  expect(c['box-shadow']).not.toBe('none');
  // Allow is the primary (warm fill), Deny the secondary (a tint), one group at the right.
  const allow = docked(app).locator('[data-act="allow"]');
  expect((await css(allow, 'background-color'))['background-color']).toBe(await role(app, '--primary'));
  expect((await css(docked(app).locator('[data-act="deny"]'), 'background-color'))['background-color']).toBe(await role(app, '--tint-2'));
});

// The dock is capped in a short window: a card taller than the cap scrolls in the dock, so its buttons stay reachable.
test('docked_tall_outbox_card_stays_reachable: at 560 px the dock scrolls and Send and Discard can be reached', async ({ app, core }) => {
  const body = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long mail about the Thursday review.`).join('\n');
  await front(app, core, () => [], (s) => [{ ...OUTBOX(s), owner: { ...OUTBOX(s).owner, args: { ...OUTBOX(s).owner.args, body } } }]);
  await app.setViewportSize({ width: 1440, height: 560 });
  await expect(outbox(app)).toHaveCount(1);
  const tabs = await app.locator('.tabs').boundingBox();
  const dock = await app.locator('.composer > .dock').boundingBox();
  expect(tabs && dock && dock.y >= tabs.y + tabs.height).toBe(true);
  for (const act of ['send-outbox', 'discard']) {
    const button = outbox(app).locator(`[data-act="${act}"]`);
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = (await button.boundingBox())!;
    const d = (await app.locator('.composer > .dock').boundingBox())!;
    expect(box.y >= d.y && box.y + box.height <= d.y + d.height).toBe(true);
  }
});

test('docked_question_and_outbox_cards_wear_the_still_ring: the same solid card as the permission card, no swell', async ({ app, core }) => {
  await front(app, core, (s) => [QUEST(s)], (s) => [OUTBOX(s)]);
  await expect(docked(app).locator('.dc-item[data-item="q1"]')).toHaveCount(1);
  await expect(outbox(app)).toHaveCount(1);
  const raised = await role(app, '--raised');
  for (const card of [docked(app), outbox(app)]) {
    const c = await css(card, 'background-color', 'background-image', 'backdrop-filter', 'border-top-left-radius', 'animation-name', 'box-shadow');
    expect(c['background-color']).toBe(raised);
    expect(c['background-image']).toBe('none');
    expect(c['backdrop-filter']).toBe('none');
    expect(c['border-top-left-radius']).toBe('12px');
    expect(c['animation-name']).toBe('none');
    expect(c['box-shadow']).not.toBe('none');
  }
  // The Outbox card's Send is the primary; its buttons sit in one group at the right.
  expect((await css(outbox(app).locator('[data-act="send-outbox"]'), 'background-color'))['background-color']).toBe(await role(app, '--primary'));
});

test('menu_rows_dialog_palette_composer: menu rows 26 radius 6 in a radius-10 menu, Stop question radius 14, palette radius 12, composer radius 14', async ({ app, core }) => {
  const a = core.agent(core.project('demo'), 'asks', 'never');
  await openWindow(app, {}, core);
  expect((await css(app.locator('.composer .cbox').first(), 'border-top-left-radius'))['border-top-left-radius']).toBe('14px');
  await app.locator(`.tabw[data-menu="tab"]`).first().click({ button: 'right' });
  const menu = app.locator('.cmenu');
  await expect(menu).toBeVisible();
  expect((await css(menu, 'border-top-left-radius'))['border-top-left-radius']).toBe('10px');
  const row = menu.locator('[role="menuitem"]').first();
  expect((await row.boundingBox())!.height).toBe(26);
  expect((await css(row, 'border-top-left-radius'))['border-top-left-radius']).toBe('6px');
  await app.keyboard.press('Escape');
  await app.keyboard.press('Meta+KeyK');
  const pal = app.getByRole('dialog', { name: 'Command palette' });
  expect((await css(pal, 'border-top-left-radius'))['border-top-left-radius']).toBe('12px');
  await pal.locator('[data-command="session.stop"]').click();
  const d = app.getByRole('alertdialog');
  await expect(d.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  const c = await css(d, 'border-top-left-radius', 'background-color', 'backdrop-filter');
  expect(c['border-top-left-radius']).toBe('14px');
  expect(c['background-color']).toBe(await role(app, '--raised'));
  expect(c['backdrop-filter']).toBe('none');
  // Cancel first, the primary last, at the right.
  const [cancel, stop] = await Promise.all([d.getByRole('button', { name: 'Cancel' }).boundingBox(), d.getByRole('button', { name: 'Stop', exact: true }).boundingBox()]);
  expect(cancel!.x).toBeLessThan(stop!.x);
  void a;
});

test('toast_is_a_solid_raised_pill: --raised, radius 10, 36 high, no glass (design book notes)', async ({ app }) => {
  // A store from before version 2 that turned copy on select off: the start-up migration says so in a toast with Undo.
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ copyOnSelect: false })));
  await openWindow(app);
  const toast = app.locator('.toast').filter({ has: app.getByRole('button', { name: 'Undo' }) });
  await expect(toast).toBeVisible();
  const c = await css(toast, 'background-color', 'backdrop-filter', 'border-top-left-radius', 'color');
  expect(c['background-color']).toBe(await role(app, '--raised'));
  expect(c['backdrop-filter']).toBe('none');
  expect(c['border-top-left-radius']).toBe('10px');
  expect(c.color).toBe(await role(app, '--text'));
  expect((await toast.boundingBox())!.height).toBe(36);
});

// ---------------------------------------------------------------- pictures on request
const OUT = process.env.SHOTS_OUT ?? path.resolve(import.meta.dirname, '../../.scratch/shots-1d');
const TAG = process.env.SHOTS_TAG ?? 'after';
const PICKS: [string, unknown][] = [
  ['nunchiro-light', LIGHT_PICK],
  ['nunchiro-dark', DARK_PICK],
  ['catppuccin-mocha', { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', colors: parseGhostty(THEMES['Catppuccin Mocha']) }],
];
const file = (theme: string, view: string) => path.join(OUT, `${TAG}-${theme}-${view}.png`);
const pick = (app: Page, p: unknown, extra: Record<string, unknown> = {}) =>
  app.addInitScript(
    ([x, more]) => {
      const was = JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}');
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...was, ...more, themeMode: 'fixed', themeFixed: x }));
    },
    [p, extra] as const,
  );
const around = async (app: Page, l: Locator, name: string, pad = 24) => {
  const b = (await l.boundingBox())!;
  const vp = app.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  await app.screenshot({ path: name, clip: { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: Math.min(vp.height - y, b.height + 2 * pad) } });
};

for (const [theme, p] of PICKS) {
  test(`cards_shot docked ${theme} @shots`, async ({ app, core }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p);
    await app.setViewportSize({ width: 1280, height: 800 });
    await front(app, core, (s) => [PERM(s)]);
    await expect(docked(app).locator('.dc-item[data-item="p1"]')).toHaveCount(1);
    await app.mouse.move(5, 5);
    await app.waitForTimeout(400);
    // The card floats above the composer (absolute): the picture spans both.
    const [c, k] = await Promise.all([docked(app).boundingBox(), app.locator('.composer .cbox').first().boundingBox()]);
    const y = c!.y - 24;
    await app.screenshot({ path: file(theme, 'permission'), clip: { x: k!.x - 24, y, width: k!.width + 48, height: k!.y + k!.height + 16 - y } });
  });

  test(`cards_shot question outbox ${theme} @shots`, async ({ app, core }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p);
    await app.setViewportSize({ width: 1280, height: 900 });
    await front(app, core, (s) => [QUEST(s)], (s) => [OUTBOX(s)]);
    await expect(outbox(app)).toHaveCount(1);
    await app.mouse.move(5, 5);
    await app.waitForTimeout(400);
    await around(app, docked(app), file(theme, 'question'));
    await around(app, outbox(app), file(theme, 'outbox'));
  });

  test(`floating_shot menu palette dialog ${theme} @shots`, async ({ app, core }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p);
    await app.setViewportSize({ width: 1280, height: 800 });
    core.agent(core.project('demo'), 'asks', 'never');
    await openWindow(app, {}, core);
    await app.locator(`.tabw[data-menu="tab"]`).first().click({ button: 'right' });
    await expect(app.locator('.cmenu')).toBeVisible();
    await app.waitForTimeout(300);
    await around(app, app.locator('.cmenu'), file(theme, 'menu'));
    await app.keyboard.press('Escape');
    await app.keyboard.press('Meta+KeyK');
    const pal = app.getByRole('dialog', { name: 'Command palette' });
    await app.waitForTimeout(300);
    await around(app, pal, file(theme, 'palette'));
    await pal.locator('[data-command="session.stop"]').click();
    const d = app.getByRole('alertdialog');
    await expect(d.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await app.mouse.move(5, 795);
    await app.waitForTimeout(300);
    await around(app, d, file(theme, 'dialog'));
  });

  test(`notes_shot toast empty status ${theme} @shots`, async ({ app }) => {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await pick(app, p, { copyOnSelect: false });
    await app.setViewportSize({ width: 1280, height: 800 });
    await app.addInitScript(() => {
      type W = { __cb: Record<number, (e: unknown) => void>; __on: Record<string, number>; __TAURI_INTERNALS__: unknown };
      const w = window as unknown as W;
      w.__cb = {};
      w.__on = {};
      let n = 0;
      w.__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          if (cmd === 'plugin:event|listen') return ((w.__on[args.event as string] = args.handler as number), Promise.resolve(1));
          if (cmd === 'rc_update_check') return Promise.resolve('0.2.0');
          return Promise.resolve(null);
        },
        transformCallback: (cb: (e: unknown) => void) => ((w.__cb[++n] = cb), n),
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      };
    });
    await openWindow(app, { rcUpdates: true });
    const toast = app.locator('.toast').first();
    await expect(toast).toBeVisible();
    await toast.hover();
    await app.waitForTimeout(300);
    await around(app, toast, file(theme, 'toast'));
    await app.mouse.move(640, 300);
    await around(app, app.locator('.tree .empty'), file(theme, 'empty'), 8);
    await expect(app.locator('footer.status .rcupdate')).toBeVisible();
    await app.locator('footer.status').screenshot({ path: file(theme, 'status-note') });
  });
}
