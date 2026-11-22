// SPLITS (PEEKSPLIT + SPLITNEW + SPLITKEYS): per-session split panes beside the chat. Dragging a bar icon over the session
// view (outside edit mode) opens it in a split; ⌘D / ⌘⇧D and prefix % / " split the focused pane; a split stays per
// session until closed and is not in the layout preset unless pinned. Real core, fake agents; one test per acceptance item.
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ENTRIES } from '../src/layout/registry';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import { drag, icon, names, pageErrors, readLayout, startEdit, stored, unapproved } from './d5b';

/** Every request this window sends over the core socket, in order. */
const record = (page: Page) =>
  page.addInitScript(() => {
    const w = window as unknown as { __sent: { op: string }[] };
    w.__sent = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const r = typeof data === 'string' ? JSON.parse(data).request : null;
        if (r) w.__sent.push(r);
      } catch {
        // Not JSON: not ours.
      }
      return send.call(this, data);
    };
  });
type Req = { op: string; id?: string; text?: string; session?: { kind: string; project: string; resume?: unknown; account?: string } };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; kind: string; state: string }[];
const sent = (page: Page, op: string) => page.evaluate((o) => (window as unknown as { __sent: Req[] }).__sent.filter((r) => r.op === o), op);

const agent = (core: Core, label: string) => core.agent(core.project('agents'), label, 'never-created'); // ticket 570: one project, one strip
const open = async (page: Page, id: string) => {
  await page.locator(`.tab[data-tab="${id}"]`).click();
  await expect(page.locator(`.chat[data-session="${id}"]`)).toBeVisible();
};
const host = (page: Page) => page.locator('[data-split-host]');
const splits = (page: Page) => page.locator('[data-split-id]');
const overlay = (page: Page) => page.locator('[data-split-overlay]');
const chooser = (page: Page) => page.getByRole('listbox', { name: 'Open in this split' });
const SIDE = '[data-side-pane]';
const STORE = 'nunchiro.splits.v1';
/** Diff as a zone of layout.toml (its header comment names every kind, so the bare word is not enough). */
const DIFF_ZONE = /widgets = \[[^\]]*"diff"/;

/** A point near one edge of the session view, so that edge's half is the nearest. */
async function near(page: Page, side: 'left' | 'right' | 'up' | 'down') {
  const b = (await host(page).boundingBox())!;
  const x = side === 'left' ? b.x + 30 : side === 'right' ? b.x + b.width - 30 : b.x + b.width / 2;
  const y = side === 'up' ? b.y + 30 : side === 'down' ? b.y + b.height - 30 : b.y + b.height / 2;
  return { x, y };
}
const dropOn = async (page: Page, name: string, side: 'left' | 'right' | 'up' | 'down') => drag(page, icon(page, 'right', name), await near(page, side));
const composerFocused = (page: Page) => expect(page.locator('.cbox textarea')).toBeFocused();

test('drag_icon_shows_halves', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  for (const [side, caption] of [['right', 'Split right'], ['left', 'Split left'], ['up', 'Split above'], ['down', 'Split below']] as const) {
    await drag(app, icon(app, 'right', 'Diff'), await near(app, side), { release: false });
    await expect(overlay(app)).toBeVisible();
    await expect(overlay(app).locator('.half')).toHaveAttribute('data-side', side);
    await expect(overlay(app).locator('.half')).toHaveText(caption);
    await app.keyboard.press('Escape');
    await expect(overlay(app)).toHaveCount(0);
    await app.mouse.up();
    await expect(splits(app)).toHaveCount(0);
  }
  // Dropping outside the session view changes nothing either.
  await drag(app, icon(app, 'right', 'Diff'), { x: 5, y: 5 });
  await expect(splits(app)).toHaveCount(0);
});

test('drop_makes_split_any_widget', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const before = { left: await names(app, 'left'), right: await names(app, 'right') };
  await dropOn(app, 'Diff', 'right');
  await expect(splits(app).filter({ has: app.locator('.sph b', { hasText: 'Diff' }) })).toHaveAttribute('data-side', 'right');
  await dropOn(app, 'Board', 'down');
  await expect(splits(app).filter({ has: app.locator('.sph b', { hasText: 'Board' }) })).toHaveAttribute('data-side', 'down');
  await dropOn(app, 'Decisions', 'left');
  await expect(splits(app).filter({ has: app.locator('.sph b', { hasText: 'Decisions' }) })).toHaveAttribute('data-side', 'left');
  await expect(splits(app)).toHaveCount(3);
  // Each sits on its side of the chat.
  const chat = (await app.locator(`.chat[data-session="${a.id}"]`).boundingBox())!;
  const box = async (n: string) => (await splits(app).filter({ has: app.locator('.sph b', { hasText: n }) }).boundingBox())!;
  expect((await box('Diff')).x).toBeGreaterThanOrEqual(chat.x + chat.width - 2);
  expect((await box('Decisions')).x + (await box('Decisions')).width).toBeLessThanOrEqual(chat.x + 2);
  expect((await box('Board')).y).toBeGreaterThanOrEqual(chat.y + chat.height - 2);
  expect({ left: await names(app, 'left'), right: await names(app, 'right') }).toEqual(before);
});

test('split_persists_per_session', async ({ app, core }) => {
  const a = agent(core, 'a');
  const b = agent(core, 'b');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await dropOn(app, 'Diff', 'right');
  await expect(splits(app)).toHaveCount(1);
  await open(app, b.id);
  await expect(splits(app)).toHaveCount(0);
  await open(app, a.id);
  await expect(splits(app)).toHaveCount(1);
  await app.reload();
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await open(app, a.id);
  await expect(splits(app)).toHaveCount(1);
  // A broken store is ignored (no split, no error): bad JSON, a wrong field type, a duplicate split id.
  const errors = pageErrors(app);
  for (const raw of ['{"x":[{"id":1', JSON.stringify({ [a.id]: [{ id: 1, side: 'right', what: 'diff' }] }), JSON.stringify({ [a.id]: [{ id: 'q', side: 'right', what: 'diff' }], [b.id]: [{ id: 'q', side: 'left', what: 'board' }] })]) {
    await app.evaluate(([k, r]) => localStorage.setItem(k, r), [STORE, raw]);
    await app.reload();
    await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await open(app, a.id);
    await expect(splits(app), raw).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  // A closed session's splits are dropped.
  await dropOn(app, 'Diff', 'right');
  await expect.poll(() => app.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}')), STORE)).toEqual([a.id]);
  core.cli('session', 'close', a.id);
  await expect.poll(() => app.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}')), STORE)).toEqual([]);
});

test('split_not_in_preset_unless_pinned', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const layoutBefore = readLayout(core);
  const barsBefore = (await stored(app)).bars;
  await dropOn(app, 'Diff', 'right');
  await expect(splits(app)).toHaveCount(1);
  // Ticket 991 A18: the chip says what is true (this session's split, not the layout's) and its tooltip says how long.
  await expect(splits(app).getByText('This session only')).toHaveAttribute('data-tip', /until you close it; not saved in the layout/);
  expect(readLayout(core)).toBe(layoutBefore);
  expect((await stored(app)).bars).toEqual(barsBefore);
  await startEdit(app);
  await expect(app.locator('.estrip .dirty')).toHaveCount(0);
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Cancel' }).click();
  // 📌: the widget joins the layout (a step of the trail), the temporary split goes.
  await splits(app).getByRole('button', { name: 'Keep in layout' }).click();
  await expect.poll(() => readLayout(core)).toMatch(DIFF_ZONE);
  await expect(app.getByText('This session only')).toHaveCount(0);
  await expect(app.locator('[data-zone-id] [data-widget="diff"]')).toHaveCount(1);
  await app.locator('.shead b').click();
  await app.keyboard.press('Meta+KeyZ');
  await expect.poll(() => readLayout(core)).not.toMatch(DIFF_ZONE);
  await expect.poll(async () => (await stored(app)).bars).toEqual(barsBefore); // the bars step lands after the zones step
  // Pinned again: the preset menu marks the arrangement changed.
  await dropOn(app, 'Diff', 'right');
  await splits(app).getByRole('button', { name: 'Keep in layout' }).click();
  await expect.poll(() => readLayout(core)).toMatch(DIFF_ZONE);
  await startEdit(app);
  await expect(app.locator('.estrip .dirty')).toHaveCount(1);
});

test('split_keys_everywhere', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  const keys: [string[], string][] = [
    [['Meta+KeyD'], 'right'],
    [['Shift+Meta+KeyD'], 'down'],
    [['Control+Period', 'Shift+Digit5'], 'right'],
    [['Control+Period', 'Shift+Quote'], 'down'],
  ];
  for (const [presses, side] of keys) {
    await app.locator('.cbox textarea').focus();
    for (const k of presses) await app.keyboard.press(k);
    await expect(splits(app), presses.join(' ')).toHaveCount(1);
    await expect(splits(app)).toHaveAttribute('data-side', side);
    await app.keyboard.press('Escape'); // the empty chooser closes
    await expect(splits(app)).toHaveCount(0);
    await composerFocused(app);
  }
  // In the side pane's terminal the same keys split the terminal area, prefix % and " included.
  await app.keyboard.press('Meta+KeyJ');
  const pty = app.locator(`${SIDE} .term[data-session="${a.id}"] .xterm-helper-textarea`);
  for (const [presses, grid] of [[['Control+Period', 'Shift+Digit5'], 'h'], [['Control+Period', 'Shift+Quote'], 'v'], [['Meta+KeyD'], 'h'], [['Shift+Meta+KeyD'], 'v']] as const) {
    await pty.focus();
    for (const k of presses) await app.keyboard.press(k);
    await expect(app.locator(`${SIDE} .tgrid`), presses.join(' ')).toHaveAttribute('data-grid', grid);
    await expect(app.locator(`${SIDE} .tgrid .term:not([hidden])`)).toHaveCount(2);
  }
  await expect(splits(app)).toHaveCount(0);
  expect((await sent(app, 'start')).filter((r) => r.session?.kind === 'shell')).toHaveLength(1); // one shell for the grid
  // No byte of any of these chords reached a PTY (the session's or the grid's shell).
  expect(await sent(app, 'send_text')).toEqual([]);
  expect(await sent(app, 'send_keys')).toEqual([]);
});

test('new_split_setting', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await expect(chooser(app)).toBeVisible();
  await app.keyboard.press('Escape');
  const choose = async (label: string) => {
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Layout' }).click();
    await app.getByRole('radio', { name: label }).check();
    await app.keyboard.press('Escape'); // v25f: close the modal before the tabs behind it
    await open(app, a.id);
    await app.locator('.cbox textarea').focus();
    await app.keyboard.press('Meta+KeyD');
  };
  await choose('Terminal');
  await expect.poll(async () => (await sent(app, 'start')).length).toBe(1);
  expect((await sent(app, 'start'))[0].session).toMatchObject({ kind: 'shell', project: a.cwd });
  await expect(splits(app).locator('.term .xterm-screen')).toBeVisible();
  await expect(app.locator('.tabs .tab')).toHaveCount(1); // the split's shell is not also a window tab
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await choose('Agent chat');
  await expect.poll(async () => (await sent(app, 'start')).length).toBe(2);
  expect((await sent(app, 'start'))[1].session).toMatchObject({ kind: 'claude', project: a.cwd, resume: null });
  await expect(splits(app).locator('.chat')).toBeVisible();
  // Settings search finds it.
  await app.keyboard.press('Meta+Comma');
  await app.getByRole('searchbox', { name: 'Search settings' }).fill('split');
  await expect(app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: /Open in a new split/ })).toBeVisible();
});

test('chooser_choices', async ({ app, core }) => {
  const a = agent(core, 'a');
  unapproved(core, 'mine'); // a user widget of the library
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  const options = chooser(app).getByRole('option');
  await expect(options.filter({ hasText: 'mine' })).toHaveCount(1);
  expect(await options.locator('b').allInnerTexts()).toEqual(['Claude', 'Codex', 'Terminal', ...ENTRIES.map((e) => e.title), 'mine']);
  // Ticket 991 A17: the agents show their logos, as the tab "+" menu does; the terminal its terminal icon.
  await expect(options.nth(0).locator('svg.agent-logo.claude')).toHaveCount(1);
  await expect(options.nth(1).locator('svg.agent-logo')).toHaveCount(1);
  // Ledger w14-room-icon: the Room entry has the Room tab's chat bubble, not the fallback code glyph.
  await expect(options.filter({ hasText: 'Room' }).locator('svg[data-icon="comment-discussion"]')).toHaveCount(1);
  await expect(options.locator('svg[data-icon="code"]')).toHaveCount(1); // only the user's own widget ("mine") falls back
  await expect(options.first()).toBeFocused();
  await app.keyboard.press('Enter');
  await expect.poll(async () => (await sent(app, 'start')).length).toBe(1);
  expect((await sent(app, 'start'))[0].session).toMatchObject({ kind: 'claude', project: a.cwd, resume: null });
  await expect(splits(app).locator('.chat')).toBeVisible();
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await app.keyboard.press('Meta+KeyD');
  await expect(chooser(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(splits(app)).toHaveCount(0);
});

test('one_view_per_pty', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await icon(app, 'right', 'Terminal').click(); // the side pane, on the PTY
  await expect(app.locator(`${SIDE} .term[data-session="${a.id}"]`)).toBeVisible();
  await dropOn(app, 'Terminal', 'right');
  await expect(splits(app).locator(`.term[data-session="${a.id}"]`)).toBeVisible();
  await expect(app.locator(`.term[data-session="${a.id}"]`)).toHaveCount(1);
  const ptyTab = app.locator(SIDE).getByRole('tab', { name: /PTY/ });
  await expect(ptyTab).toContainText('Shown in a split');
  await ptyTab.click();
  await expect(splits(app).locator('.xterm-helper-textarea')).toBeFocused();
  await app.keyboard.type('hi');
  await expect.poll(async () => (await sent(app, 'send_text')).filter((r) => r.id === a.id).map((r) => r.text).join('')).toBe('hi');
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await expect(app.locator(`${SIDE} .term[data-session="${a.id}"]`)).toBeVisible();
  await expect(ptyTab).toHaveCount(0); // the slim tab row only shows while the PTY is in a split (the pane's strip is gone, ticket 284 item 4)
  await app.locator(`${SIDE} .term[data-session="${a.id}"] .xterm-helper-textarea`).focus();
  await app.keyboard.type('yo');
  await expect.poll(async () => (await sent(app, 'send_text')).filter((r) => r.id === a.id).map((r) => r.text).join('')).toBe('hiyo');
});

test('split_close', async ({ app, core }) => {
  const a = agent(core, 'a');
  // split.close has no default key: bind one for the test.
  await app.addInitScript(() => localStorage.getItem('nunchiro.settings.v1') || localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bindings: { 'split.close': ['Control+Alt+KeyW'] } })));
  await openWindow(app, {}, core);
  await open(app, a.id);
  await dropOn(app, 'Diff', 'right');
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await expect(splits(app)).toHaveCount(0);
  await composerFocused(app);
  await dropOn(app, 'Diff', 'right');
  await dropOn(app, 'Board', 'left');
  await splits(app).filter({ has: app.locator('.sph b', { hasText: 'Board' }) }).focus();
  await app.keyboard.press('Control+Alt+KeyW');
  await expect(splits(app)).toHaveCount(1);
  await expect(splits(app).locator('.sph b')).toHaveText(`Diff · a`);
  await composerFocused(app);
});

test('axe_splits', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const check = async (label: string) => {
    // The split UI only: the chat feed under it is AGENTVIEW's (its empty `.clist` trips aria-required-children while it loads).
    const r = await new AxeBuilder({ page: app }).include('[data-split-overlay]').include('[data-split-id]').include('.spane .tdh').analyze();
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${label} ${v.id}: ${v.help} ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  };
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await drag(app, icon(app, 'right', 'Diff'), await near(app, 'right'), { release: false });
    await expect(overlay(app)).toBeVisible();
    await check(`${scheme} overlay`);
    await app.mouse.up();
    await expect(splits(app)).toHaveCount(1);
    await check(`${scheme} split`);
    await splits(app).getByRole('button', { name: 'Close split' }).click();
    await expect(splits(app), `${scheme} closed`).toHaveCount(0);
    // Off the ✕: the next split's ✕ appears under a pointer left there, and its tooltip would take the Esc (V1A-65).
    const off = await near(app, 'left');
    await app.mouse.move(off.x, off.y);
    await app.keyboard.press('Meta+KeyD');
    await expect(chooser(app)).toBeVisible();
    await check(`${scheme} chooser`);
    await expect(chooser(app).getByRole('option').first()).toBeFocused();
    await app.keyboard.press('Escape');
    await expect(splits(app), `${scheme} chooser closed`).toHaveCount(0);
  }
});

// V2.5-41 (rc2-newreds): Escape on the ⌘D chooser closes the empty split and gives the composer back. A tooltip showing
// under a resting pointer takes the first Esc and nothing else (V1A-65, needs 72, tooltip.spec.ts tooltip-esc); the next
// Esc is the chooser's. axe_splits went red when its pointer rested on the spot where the next split's ✕ appears.
test('split_chooser_closes_on_escape', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await expect(chooser(app).getByRole('option').first()).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(splits(app)).toHaveCount(0);
  await composerFocused(app);
  // With the ✕'s tooltip showing, the first Esc hides only the tooltip; the second closes the chooser.
  await app.keyboard.press('Meta+KeyD');
  await expect(chooser(app).getByRole('option').first()).toBeFocused();
  await splits(app).getByRole('button', { name: 'Close split' }).dispatchEvent('pointerover');
  await expect(app.getByRole('tooltip')).toHaveText('Close split');
  await app.keyboard.press('Escape');
  await expect(app.getByRole('tooltip')).toBeHidden();
  await expect(chooser(app).getByRole('option').first()).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(splits(app)).toHaveCount(0);
  await composerFocused(app);
});

test('reach_two_clicks', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD'); // one key
  await expect(splits(app)).toHaveCount(1);
  await app.keyboard.press('Escape');
  await icon(app, 'left', 'Settings').click(); // click 1
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Layout' }).click(); // click 2
  await expect(app.getByRole('radiogroup', { name: /Open in a new split/ })).toBeVisible();
});

// REPORT page: the approved mockup (frame-ko-e.html, its "목업 컨트롤" buttons) and this app at the same 1440x900, light and
// dark. Run with SHOTS=1 (chromium only); writes .scratch/splits/ and side-by-side.html.
const MOCKUP = path.join(REPO, '.scratch/v2-drafts/ko/frame-ko-e.html');
const OUT = path.join(REPO, '.scratch/splits');
const STATES = ['overlay', 'diff', 'shell', 'grid-h', 'grid-v'] as const;
const MOCK: Record<(typeof STATES)[number], string[]> = { overlay: ['[data-mk2="drag"]'], diff: ['[data-mk2="diff"]'], shell: ['[data-mk2="shell"]'], 'grid-h': ['[data-mk2="none"]', '[data-mk3="h"]'], 'grid-v': ['[data-mk3="v"]'] };

test('frame_side_by_side', async ({ app, core, browser }, info) => {
  test.skip(info.project.name !== 'chromium' || !process.env.SHOTS, 'run with SHOTS=1');
  test.skip(!fs.existsSync(MOCKUP), `mockup frame absent: ${MOCKUP}`);
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  const a = agent(core, 'ux-fix-2');
  await openWindow(app, {}, core);
  await open(app, a.id);
  const mock = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mock.goto(`file://${MOCKUP}`);
  const shot = async (name: (typeof STATES)[number], scheme: string) => {
    await app.screenshot({ path: path.join(OUT, `app-${name}-${scheme}.png`) });
    await mock.evaluate((c) => (document.documentElement.dataset.theme = c), scheme);
    for (const b of MOCK[name]) await mock.locator(b).click();
    await mock.screenshot({ path: path.join(OUT, `mock-${name}-${scheme}.png`) });
  };
  const term = `${SIDE} .term[data-session="${a.id}"] .xterm-helper-textarea`;
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await drag(app, icon(app, 'right', 'Diff'), await near(app, 'right'), { release: false });
    await shot('overlay', scheme);
    await app.keyboard.press('Escape');
    await app.mouse.up();
    await dropOn(app, 'Diff', 'right');
    await shot('diff', scheme);
    await splits(app).getByRole('button', { name: 'Close split' }).click();
    await app.keyboard.press('Meta+KeyD');
    await chooser(app).getByRole('option', { name: /^Terminal new shell/ }).click();
    await splits(app).locator('.xterm-screen').waitFor();
    await shot('shell', scheme);
    await splits(app).getByRole('button', { name: 'Close split' }).click();
    await app.keyboard.press('Meta+KeyJ');
    await app.locator(term).focus();
    await app.keyboard.press('Meta+KeyD');
    await expect(app.locator(`${SIDE} .tgrid .term`)).toHaveCount(2);
    await app.locator(`${SIDE} .tgrid .xterm-screen`).nth(1).waitFor();
    await shot('grid-h', scheme);
    await app.locator(term).focus();
    await app.keyboard.press('Shift+Meta+KeyD');
    await expect(app.locator(`${SIDE} .tgrid`)).toHaveAttribute('data-grid', 'v');
    await shot('grid-v', scheme);
    await mock.locator('[data-mk3="v"]').click(); // back to one terminal
    await app.locator(SIDE).getByRole('button', { name: /^Close shell/ }).click();
    await app.keyboard.press('Meta+KeyJ');
  }
  await mock.close();
  const cell = (n: string, sc: string) => `<td><img src="mock-${n}-${sc}.png" alt="mockup ${n} ${sc}"></td><td><img src="app-${n}-${sc}.png" alt="app ${n} ${sc}"></td>`;
  fs.writeFileSync(
    path.join(OUT, 'side-by-side.html'),
    `<!doctype html><meta charset="utf-8"><title>SPLITS side by side</title><style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px;vertical-align:top}img{width:700px;display:block}</style>` +
      `<h1>SPLITS: frame-ko-e mockup | app, 1440x900</h1><table><tr><th>state</th><th>mockup</th><th>app</th></tr>` +
      STATES.flatMap((n) => ['light', 'dark'].map((sc) => `<tr><th>${n}<br>${sc}</th>${cell(n, sc)}</tr>`)).join('') +
      `</table>`,
  );
});

test('split_agent_chat_accepts_input', async ({ app, core }) => {
  const a = agent(core, 'a');
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Claude/ }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude' && s.id !== a.id && s.state === 'running').length).toBe(1);
  const b = snap(core).find((s) => s.kind === 'claude' && s.id !== a.id)!;
  await expect(splits(app).locator(`.chat[data-session="${b.id}"]`)).toBeVisible();
  // The split has its own composer, bound to the split's session (the window composer stays on a).
  const box = splits(app).getByRole('combobox', { name: /^Message / }); // the composer is a combobox (chat lane menus)
  await expect(box).toBeEnabled();
  await box.fill('hello split');
  await box.press('Enter');
  await expect.poll(async () => (await sent(app, 'send_text')).filter((r) => r.id === b.id).map((r) => r.text).join('')).toContain('hello split');
  expect((await sent(app, 'send_text')).filter((r) => r.id === a.id)).toEqual([]);
  await expect(splits(app).locator('.chip.pin')).toBeHidden();
});

test('split_agent_uses_last_account', async ({ app, core }) => {
  const ID = '0123456789abcdef0123456789abcdef';
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "Work"\n`);
  const p = core.project('a');
  const a = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'a', '--account', 'Work').session as { id: string; cwd: string };
  await record(app);
  await openWindow(app, {}, core);
  await open(app, a.id);
  // The window reads the account list once per connection (its sign-in probes take seconds with the fake agent).
  await expect.poll(async () => (await sent(app, 'account_list')).length).toBe(1);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Claude/ }).click();
  await expect.poll(async () => (await sent(app, 'start')).length, { timeout: 20_000 }).toBe(1);
  expect((await sent(app, 'start'))[0].session).toMatchObject({ kind: 'claude', project: a.cwd, account: 'Work' });
});

test('split_shell_closed_with_session', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Terminal new shell/ }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(1);
  const sh = snap(core).find((s) => s.kind === 'shell')!;
  core.cli('session', 'close', a.id);
  await expect.poll(() => snap(core).find((s) => s.id === sh.id)?.state ?? 'gone').not.toBe('running');
  await expect.poll(() => app.evaluate((k) => localStorage.getItem(k), STORE)).toBe('{}');
});

// Look 1117 v9 (A S3-2): a split's shell, closed with its split, leaves no "New terminal" row in the done fold.
test('split_shell_leaves_no_done_row', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Terminal new shell/ }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(1);
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell').length).toBe(0);
});

// Look 1117 v11 A S3-9: an idle agent's split closes as a shell's does; it no longer stays behind as a window tab.
test('split_agent_closed_with_split', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Claude/ }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'claude' && s.id !== a.id && s.state === 'running').length).toBe(1);
  const b = snap(core).find((s) => s.kind === 'claude' && s.id !== a.id)!;
  await expect(splits(app).locator(`.chat[data-session="${b.id}"]`)).toBeVisible();
  await splits(app).getByRole('button', { name: 'Close split' }).click();
  await expect.poll(() => snap(core).find((s) => s.id === b.id)?.state ?? 'gone').not.toBe('running');
  await expect(app.locator(`.tab[data-tab="${b.id}"]`)).toHaveCount(0);
});

test('split_no_duplicate_title', async ({ app, core }) => {
  const a = agent(core, 'a');
  await openWindow(app, {}, core);
  await open(app, a.id);
  await dropOn(app, 'Diff', 'right');
  // The split header names it; the Diff widget's own title row keeps only its controls (Refresh).
  await expect(splits(app).locator('.sph b')).toHaveText('Diff · a');
  await expect(splits(app).locator('.diff > .ph')).toHaveCSS('font-size', '0px');
  await expect(splits(app).locator('.diff > .ph .grip')).toBeHidden();
  await expect(splits(app).locator('.diff > .ph .r')).toBeHidden(); // the session is in the split header too
  await expect(splits(app).getByRole('button', { name: 'Refresh Diff' })).toBeVisible();
});

test('split_shell_kept_when_session_only_missing', async ({ app, core }) => {
  const a = agent(core, 'a');
  // Frames the window gets can leave a session out (a partial list): drop `a` from snapshots once `hide` is set.
  const st = { hide: false, last: null as unknown, sockets: [] as { send(m: string): void }[] };
  const cut = (m: { sessions: { id: string }[] }) => JSON.stringify(st.hide ? { ...m, sessions: m.sessions.filter((s) => s.id !== a.id) } : m);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    st.sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      st.last = msg;
      ws.send(cut(msg));
    });
  });
  await openWindow(app, {}, core);
  await open(app, a.id);
  await app.locator('.cbox textarea').focus();
  await app.keyboard.press('Meta+KeyD');
  await chooser(app).getByRole('option', { name: /^Terminal new shell/ }).click();
  await expect.poll(() => snap(core).filter((s) => s.kind === 'shell' && s.state === 'running').length).toBe(1);
  const sh = snap(core).find((s) => s.kind === 'shell')!;
  st.hide = true;
  for (const ws of st.sockets) ws.send(cut(structuredClone(st.last) as never));
  await expect.poll(() => app.evaluate((k) => localStorage.getItem(k), STORE)).toBe('{}');
  await app.waitForTimeout(500);
  expect(snap(core).find((s) => s.id === sh.id)?.state).toBe('running');
});
