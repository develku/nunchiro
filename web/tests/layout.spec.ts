// Layout edit (V1A-07b; spec Window (v1a) Layout edit, Acceptance 13 and 14; needs 26, 31, 37, 39). Every test runs
// a real core with its own NUNCHIRO_HOME under .scratch, so layout.toml is never the user's.
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { boxes, Core, expect, openWindow, test, unmoved, legacyLayout, showComposer } from './fixtures';
import { layoutCli } from './d5b';
import { openQuiet } from './tree-seed';

test.beforeEach(({ core }) => legacyLayout(core)); // D5b: the default window has no tree or AGENTS zone; this spec is about zones, so it starts from their old shape

const file = (core: Core) => path.join(core.home, 'layout.toml');
const read = (core: Core) => (fs.existsSync(file(core)) ? fs.readFileSync(file(core), 'utf8') : '');
const zones = (page: Page) => page.$$eval('[data-zone-id]', (els) => els.map((e) => (e as HTMLElement).dataset.zoneId));
const zone = (page: Page, id: string) => page.locator(`[data-zone-id="${id}"]`);
const edit = (page: Page) => page.locator('nav[data-bar="right"] .lay').click();
const done = (page: Page) => page.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Done' }).click();
/** A library card dropped on an edge of the layout (a window's own edit, where the CLI would pick one window). */
async function dropOnEdge(page: Page, kind: string, side: 'left' | 'right') {
  // The drawer slides in after Edit: a box measured mid-slide lands the press on the neighbouring card (context-2).
  // The cards also move down when the widget list arrives (as d5b.ts startEdit waits): the library is busy until then.
  await expect(page.locator('.lib')).not.toHaveAttribute('aria-busy', 'true');
  await page.locator('.lib').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.locator(`.lib .lcard[data-card="${kind}"]`).scrollIntoViewIfNeeded(); // Context is below the fold
  const c = (await page.locator(`.lib .lcard[data-card="${kind}"]`).boundingBox())!;
  const l = (await page.locator('.layout').boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 6, c.y + c.height / 2 + 6, { steps: 2 });
  await page.mouse.move(side === 'left' ? l.x + 8 : l.x + l.width - 8, l.y + l.height / 2, { steps: 8 });
  await page.mouse.up();
}
/** A point in a zone: fx, fy are fractions of its box. */
async function at(page: Page, id: string, fx: number, fy: number) {
  const b = (await zone(page, id).boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}
async function grab(page: Page, handle: Locator) {
  // hover waits until the drawer has slid in and the handle is still.
  await handle.hover();
  await page.mouse.down();
}
async function dragTo(page: Page, handle: Locator, to: { x: number; y: number }) {
  await grab(page, handle);
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}
const card = (page: Page, kind: string) => page.locator(`.lcard[data-card="${kind}"]`);

test('fresh checkout: no layout.toml means the default layout, and nothing is written until a change', async ({ app, core }) => {
  fs.rmSync(file(core)); // the D5b default: the centre column only
  await openWindow(app);
  expect(await zones(app)).toEqual(['terminal', 'composer']);
  await app.waitForTimeout(600);
  expect(fs.existsSync(file(core))).toBe(false);
});

test('drag move: a zone grip dropped on the right of another zone moves the widget and echoes its command', async ({ app, core }) => {
  await openWindow(app);
  await edit(app);
  await dragTo(app, zone(app, 'context').locator('.zl'), await at(app, 'terminal', 0.92, 0.5));
  await expect(app.locator('.emsg')).toHaveText(''); // needs 153: no ':' echo of the drag
  await done(app);
  await expect.poll(() => read(core)).toContain('widgets = ["context"]');
  // AGENTS now sits to the right of the terminal, and the left column collapsed into the tree.
  const t = (await zone(app, 'terminal').boundingBox())!;
  const a = (await zone(app, 'context').boundingBox())!;
  expect(a.x).toBeGreaterThan(t.x + t.width - 2);
  expect(await zones(app)).toEqual(['tree', 'terminal', 'context', 'waiting', 'composer']);
});

test('command move: the typed command does what the drag does', async ({ app, core }) => {
  await openWindow(app);
  await edit(app);
  await layoutCli(app, core, 'move context split right --zone terminal');
  await done(app);
  await expect.poll(() => read(core)).toContain('widgets = ["context"]');
  expect(await zones(app)).toEqual(['tree', 'terminal', 'context', 'waiting', 'composer']);
});

test('drop preview names the result, the sizes after Done, the session and the command', async ({ app }) => {
  await openWindow(app);
  await edit(app);
  await expect(app.getByRole('complementary', { name: 'Widget library' })).toBeVisible();
  await grab(app, card(app, 'terminal'));
  const t = (await zone(app, 'terminal').boundingBox())!;
  await app.mouse.move(t.x + t.width * 0.9, t.y + t.height / 2, { steps: 6 });
  const preview = app.locator('.dropprev');
  await expect(preview).toContainText('Terminal · split right of Chat');
  const half = Math.floor(t.width / 2);
  await expect(preview).toContainText(`after Done: Chat ${half} px, Terminal ${half} px (minimum 240 and 240 px)`);
  await expect(preview).toContainText('session: follows the focused one');
  await expect(preview).not.toContainText(':split'); // needs 153: no ':' command in the preview
  // V1A-58: the label stays centred under its own class.
  await expect(preview.getByRole('status')).toHaveCSS('text-align', 'center');
  // The drawer steps aside while dragging, so the sizes are the real ones.
  await expect(app.locator('.win')).toHaveAttribute('data-dragging', 'true');
  await app.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 4 });
  await expect(preview).toContainText('stack as a tab in Chat');
  await expect(preview).not.toContainText(':stack');
  const layout = (await app.locator('.layout').boundingBox())!;
  await app.mouse.move(layout.x + 6, layout.y + layout.height / 2, { steps: 4 });
  await expect(preview).toContainText('new zone at the left edge');
  await expect(preview).not.toContainText(':edge');
  await app.mouse.move(t.x + t.width * 0.9, t.y + t.height / 2, { steps: 4 });
  await app.mouse.up();
  await expect(preview).toHaveCount(0);
  expect(await zones(app)).toContain('terminal-2');
});

test('split minimum: a zone too small for both halves refuses the split and names the sizes', async ({ app, core }) => {
  await openWindow(app);
  // needs 153: typed through `nunchiro layout`, which reports the refusal itself.
  expect(() => core.cli('layout', 'split', 'down', 'terminal', '--zone', 'context')).toThrow('too small: context is 190 px high; split down needs 80 + 120 px');
  expect(await zones(app)).toEqual(['tree', 'context', 'terminal', 'waiting', 'composer']);
  await edit(app);
  // The drop preview says the same before anything is dropped.
  await grab(app, card(app, 'terminal'));
  const p = await at(app, 'context', 0.5, 0.8);
  await app.mouse.move(p.x, p.y, { steps: 6 });
  await expect(app.locator('.dropprev')).toHaveAttribute('data-error', 'true');
  await expect(app.locator('.dropprev')).toContainText('too small');
  await app.mouse.up();
  expect(await zones(app)).toEqual(['tree', 'context', 'terminal', 'waiting', 'composer']);
  await done(app);
  expect(read(core)).not.toContain('context-2');
});

test('duplicate: a widget can be placed twice, and both copies are live', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'alpha');
  core.shell(p, 'beta');
  await openWindow(app);
  await edit(app);
  await layoutCli(app, core, 'edge right context');
  await done(app);
  await expect.poll(() => read(core)).toContain('id = "context-2"');
});

test('pin: a pinned terminal keeps its session while the other follows focus; the chip names it (Hangul too)', async ({ app, core }) => {
  const p = core.project('demo');
  const alpha = core.shell(p, 'alpha');
  const beta = core.shell(p, '리뷰-03', '/bin/sh', '-c', 'echo pinned-scrollback; exec cat');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${alpha.id}"]`).click();
  await edit(app);
  await layoutCli(app, core, 'split right terminal --pin 리뷰-03 --zone terminal');
  await done(app);
  const pinned = zone(app, 'terminal-2');
  await expect(pinned.locator('.shead .pin')).toHaveText('📌 리뷰-03');
  await expect(pinned.locator(`.term[data-session="${beta.id}"]`)).toBeVisible();
  // The session is also open as a tab: the pinned copy still gets its scrollback.
  await expect(pinned.locator('.xterm-rows')).toContainText('pinned-scrollback');
  // Focus moves; the pinned zone stays on its session, the unpinned one follows.
  await app.locator(`.tab[data-tab="${beta.id}"]`).first().click();
  await app.locator(`.tab[data-tab="${alpha.id}"]`).first().click();
  await expect(pinned.locator(`.term[data-session="${beta.id}"]`)).toBeVisible();
  await expect(zone(app, 'terminal').locator(`.term[data-session="${alpha.id}"]`)).toBeVisible();
  await expect.poll(() => read(core)).toContain('widgets = ["terminal@리뷰-03"]');
});

/** A window's own save where a test needs one (ticket 1031: was the Lock switch): the tree column's gutter one step right. */
async function nudge(page: Page) {
  await page.getByRole('separator', { name: 'Resize zone group' }).focus();
  await page.keyboard.press('ArrowRight');
}

test('gutters: a gutter resizes without edit mode; an old `locked = true` file loads with its grips and gutters, and there is no Lock anywhere (ticket 1031)', async ({ app, core }) => {
  fs.writeFileSync(file(core), read(core).replace('locked = false', 'locked = true')); // a file an older Nunchiro locked
  await openWindow(app);
  await expect(app.locator('.status .lerr')).toHaveCount(0); // the old line is no error
  await expect(app.getByRole('switch', { name: /lock/i })).toHaveCount(0);
  const gutter = app.getByRole('separator', { name: 'Resize zone group' }); // ticket 811: "left" is a split of zones, named by a generic word, never its id
  await expect(gutter).toHaveCount(1);
  await expect(app.locator('.ph .grip').first()).toBeVisible();
  // Keyboard path for the gutter: arrows move it 16 px.
  await gutter.focus();
  await app.keyboard.press('ArrowRight');
  await expect.poll(() => read(core)).toContain('size = 272');
  expect(read(core)).not.toContain('locked'); // read and dropped: the next save writes no such line
  expect(Math.round((await zone(app, 'tree').boundingBox())!.width)).toBe(272);
  // And by pointer.
  const g = (await gutter.boundingBox())!;
  await app.mouse.move(g.x + g.width / 2, g.y + 200);
  await app.mouse.down();
  await app.mouse.move(g.x + g.width / 2 + 40, g.y + 200, { steps: 4 });
  await app.mouse.up();
  await expect.poll(() => read(core)).toContain('size = 312');
  // Edit mode keeps the dividers and shows no Locked badge.
  await edit(app);
  await expect(gutter).toHaveCount(1);
  await expect(app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Locked' })).toHaveCount(0);
});

test('waiting-removal notice: removing the answer strip first says only signals remain and how to bring it back', async ({ app, core }) => {
  legacyLayout(core, { strip: 'top' }); // needs 107 (ticket 180): the strip is not drawn above the composer
  await openWindow(app);
  await edit(app);
  await expect(zone(app, 'waiting').locator('.zwarn')).toContainText('Nunchiro shows waiting items only in');
  await zone(app, 'waiting').getByRole('button', { name: 'Remove Answer strip from the Answer strip zone' }).click();
  const notice = app.getByRole('alertdialog', { name: 'Remove the answer strip?' });
  await expect(notice).toContainText('only signals remain: tree rows, AGENTS dots, tab dots and the menu bar count');
  await expect(notice).toContainText("from Layout's widget library"); // needs 153: no ':add waiting'
  await notice.getByRole('button', { name: 'Keep it' }).click();
  await expect(app.locator('#waiting-strip')).toHaveCount(1);
  await zone(app, 'waiting').getByRole('button', { name: 'Remove Answer strip from the Answer strip zone' }).click();
  await notice.getByRole('button', { name: 'Remove' }).click();
  await expect(app.locator('#waiting-strip')).toHaveCount(0);
  await expect(app.locator('.emsg')).toContainText("the Answer strip card in Layout's widget library brings it back");
  // A22: removing the last zone signal is accepted now (the Tree always shows waiting); was a refusal "waiting would show only in the menu bar".
  await zone(app, 'context').getByRole('button', { name: /^Remove .* from the Context zone$/ }).click();
  await expect(zone(app, 'context')).toHaveCount(0);
  const undo = app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: /^Undo/ });
  await undo.click(); // brings AGENTS back
  await undo.click(); // brings the strip back
  await done(app);
  await expect(app.locator('#waiting-strip')).toHaveCount(1);
  expect(await zones(app)).toEqual(['tree', 'context', 'waiting', 'terminal', 'composer']); // ticket 180: strip placed on top
  await expect.poll(() => read(core)).toContain('widgets = ["waiting"]');
});

test('Reset restores the default layout', async ({ app, core }) => {
  await openWindow(app);
  core.cli('layout', 'edge', 'left', 'terminal'); // needs 153: typed changes come through `nunchiro layout`
  core.cli('layout', 'remove', 'context');
  await expect.poll(() => zones(app)).toContain('terminal-2');
  await edit(app);
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Default', exact: true }).click();
  expect(await zones(app)).toEqual(['terminal', 'composer']); // D5b: Default is the centre column
  await done(app);
  await expect.poll(() => read(core)).not.toContain('terminal-2');
  expect(read(core)).not.toContain('id = "waiting"'); // was toContain: A22, the default has no strip zone
});

test('3-step Undo: four changes, three undos back to after the first; a fourth finds nothing', async ({ app }) => {
  await openWindow(app);
  await edit(app);
  // needs 153: the four changes are the window's own (library drops and ✕), not typed lines.
  await dropOnEdge(app, 'context', 'right');
  const first = await zones(app);
  await dropOnEdge(app, 'waiting', 'left');
  await zone(app, 'composer').getByRole('button', { name: /^Remove .* from the Composer zone$/ }).click();
  await zone(app, 'tree').getByRole('button', { name: /^Remove .* from the Tree zone$/ }).click();
  const undo = app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: /^Undo/ });
  await expect(undo).toHaveAccessibleName('Undo (3 of 3 steps)');
  for (let i = 0; i < 3; i++) await undo.click();
  expect(await zones(app)).toEqual(first);
  await expect(undo).toBeDisabled();
});

/** Opens a second window on a core, as a second Nunchiro window would. */
async function secondWindow(page: Page, core: Core) {
  const other = await page.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(other, {}, core);
  return other;
}

test('Acceptance 14: split, stack, pin and remove give the same layout.toml from the GUI and from nunchiro layout', async ({ app, core }) => {
  // GUI: drags, the command line and the ✕ button.
  await openWindow(app);
  await edit(app);
  await grab(app, card(app, 'terminal'));
  const t = await at(app, 'terminal', 0.9, 0.5);
  await app.mouse.move(t.x, t.y, { steps: 6 });
  await app.mouse.up();
  await layoutCli(app, core, 'pin beta --zone terminal-2');
  await grab(app, card(app, 'context'));
  const tr = await at(app, 'tree', 0.5, 0.5);
  await app.mouse.move(tr.x, tr.y, { steps: 6 });
  await app.mouse.up();
  await layoutCli(app, core, 'pin alpha --zone terminal');
  await zone(app, 'waiting').getByRole('button', { name: 'Remove Answer strip from the Answer strip zone' }).click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await done(app);
  // Done has saved: the removed zone is gone from the file ('terminal@alpha' was there already, from the pin's own save).
  await expect.poll(() => read(core)).not.toContain('id = "waiting"');
  const gui = read(core);
  expect(gui).not.toContain('locked'); // ticket 1031

  // CLI: the same actions on a second core with its own window.
  const other = new Core(`cli-${test.info().workerIndex}-${Date.now()}`);
  try {
    await other.ready();
    legacyLayout(other);
    await secondWindow(app, other);
    for (const step of [
      ['split', 'right', 'terminal', '--zone', 'terminal'],
      ['pin', 'beta', '--zone', 'terminal-2'],
      ['stack', 'context', '--zone', 'tree'],
      ['pin', 'alpha', '--zone', 'terminal'],
      ['remove', 'waiting'],
    ])
      expect(other.cli('layout', ...step).type).toBe('text');
    expect(read(other)).toBe(gui);
    // Reset gives the default; Undo steps back 3 and no further.
    other.cli('layout', 'reset');
    expect(read(other)).not.toContain('id = "waiting"'); // was toContain: A22, the default has no strip zone
    expect(read(other)).not.toContain('terminal-2');
    other.cli('layout', 'undo');
    expect(read(other)).toBe(gui);
    other.cli('layout', 'undo');
    expect(read(other)).toContain('id = "waiting"');
    expect(read(other)).toContain('widgets = ["terminal@alpha"]');
    other.cli('layout', 'undo');
    expect(read(other)).not.toContain('terminal@alpha');
    expect(read(other)).toContain('terminal@beta');
    expect(() => other.cli('layout', 'undo')).toThrow(/nothing to undo/);
  } finally {
    await other.stop();
  }

  // A restart restores it: a fresh core and window read the same file.
  core.cli('serve', 'stop', '--yes');
  await core.restart();
  const again = await secondWindow(app, core);
  expect(await zones(again)).toEqual(['tree', 'context', 'terminal', 'terminal-2', 'composer']);
  await expect(zone(again, 'terminal-2').locator('.shead .pin')).toHaveText('📌 beta');
  expect(read(core)).toBe(gui);
});

test('nunchiro layout: removing the strip says what remains; a window in edit mode refuses; bad commands are named', async ({ app, core }) => {
  await openWindow(app);
  const out = core.cli('layout', 'remove', 'waiting');
  expect(out.text).toContain('answer strip removed: only signals remain');
  expect(out.text).toContain('nunchiro layout add waiting');
  expect(() => core.cli('layout', 'split', 'right', 'chat')).toThrow(/unknown widget "chat"/);
  await edit(app);
  expect(() => core.cli('layout', 'add', 'waiting')).toThrow(/editing the layout: press Done or Cancel/);
});

test('invalid or newer layout.toml: kept untouched, the window keeps its last good layout and names the line', async ({ app, core }) => {
  await openWindow(app);
  await nudge(app); // the core writes the file once, so `good` is its own text
  await expect.poll(() => read(core)).toContain('size = 272');
  const good = read(core);
  const bad = good.replace('widgets = ["context"]', 'widgets = ["chat"]');
  fs.writeFileSync(file(core), bad);
  const line = bad.split('\n').findIndex((l) => l.includes('"chat"')) + 1;
  const alert = app.locator('.status .lerr');
  await expect(alert).toContainText(`layout.toml has a problem on line ${line}.`);
  await expect(alert).toHaveAttribute('title', `layout.toml line ${line}: unknown widget "chat"; widgets: tree, waiting, terminal, composer, diff, files, board, search, preview, artifacts, decisions, room, context`);
  await expect(alert).toContainText('using the last good layout');
  expect(await zones(app)).toEqual(['tree', 'context', 'terminal', 'waiting', 'composer']);
  // A change in the window is not saved over the broken file.
  await nudge(app);
  await app.waitForTimeout(300);
  expect(read(core)).toBe(bad);
  fs.writeFileSync(file(core), 'version = 2\nfloating = true\n');
  await expect(alert).toContainText('layout.toml has a problem on line 1.');
  await expect(alert).toHaveAttribute('title', /^layout\.toml line 1: version 2 is newer than this Nunchiro reads \(1\)/);
  await app.waitForTimeout(300);
  expect(read(core)).toBe('version = 2\nfloating = true\n');
  // A valid hand edit is picked up.
  fs.writeFileSync(file(core), good.replace('size = 272', 'size = 300'));
  await expect(alert).toHaveCount(0);
  await expect.poll(async () => Math.round((await zone(app, 'tree').boundingBox())!.width)).toBe(300);
});

test('two windows editing at once: last Done wins, and the other window shows it and says so while editing', async ({ app, core }) => {
  await openWindow(app);
  const b = await secondWindow(app, core);
  await edit(app);
  await edit(b);
  await dropOnEdge(app, 'context', 'right');
  await dropOnEdge(b, 'waiting', 'left');
  await done(app);
  await expect.poll(() => read(core)).toContain('context-2');
  await expect(b.locator('.emsg')).toContainText('layout.toml changed elsewhere. Done will overwrite it');
  await done(b);
  await expect.poll(() => read(core)).toContain('waiting-2');
  expect(read(core)).not.toContain('context-2');
  await expect.poll(() => zones(app)).toEqual(['waiting-2', 'tree', 'context', 'terminal', 'waiting', 'composer']);
});

test('prefix L with a Korean input source enters edit mode; a Hangul session name pins through the CLI', async ({ app, core }) => {
  core.shell(core.project('demo'), '리뷰-03');
  await openWindow(app);
  const key = (init: Record<string, unknown>) => app.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);
  await key({ code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await key({ code: 'KeyL', key: 'Process', keyCode: 229 });
  await expect(app.getByRole('toolbar', { name: 'Layout edit' })).toBeVisible();
  // needs 153: the ':' command line (its completion and Hangul handling) is gone; a Hangul session name still pins
  // through `nunchiro layout`.
  await layoutCli(app, core, 'pin 리뷰-03 --zone terminal');
  await expect(zone(app, 'terminal').locator('.zl .pin')).toHaveText('📌 리뷰-03');
});

for (const how of ['composer', 'terminal'] as const)
  test(`edit mode: arrivals never take focus from the ${how}, move nothing, or break Hangul composition`, async ({ app, core, browserName }) => {
    legacyLayout(core, { strip: 'beside' }); // needs 107 (ticket 180): no strip above the composer; a user's zone beside the terminal
    const p = core.project('nunchiro');
    const writer = core.shell(p, 'writer');
    const agents = ['a', 'b', 'c'].map((t) => core.agent(p, `agent-${t}`, `go-${t}`).id);
    openQuiet(core); // V2-9a: quiet projects start folded
    await openWindow(app);
    await app.locator(`.tab[data-tab="${writer.id}"]`).click();
    if (how === 'composer') await showComposer(app); // V2.5-34: a shell's composer is asked for
    await edit(app);
    await app.locator('.lib').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const target = how === 'composer' ? app.locator('#composer') : app.locator(`.term[data-session="${writer.id}"] textarea`);
    await target.focus();
    const cdp = browserName === 'chromium' ? await app.context().newCDPSession(app) : null;
    if (how === 'composer') await app.keyboard.insertText('답장 ');
    if (cdp) await cdp.send('Input.imeSetComposition', { text: '눈', selectionStart: 1, selectionEnd: 1 });
    const before = await boxes(app);
    // Keyed by zone, so the boxes an arrival may move can be named.
    const zoneBoxes = () =>
      app.$$eval('[data-zone-id], .zl, .wcard', (els) =>
        Object.fromEntries(els.map((e, i) => [(e as HTMLElement).dataset.zoneId ?? (e.classList.contains('zl') ? `${e.closest<HTMLElement>('[data-zone-id]')!.dataset.zoneId}:zl` : `card-${i}`), JSON.stringify(e.getBoundingClientRect())])),
      );
    const zonesBefore = await zoneBoxes();
    for (const t of ['go-a', 'go-b', 'go-c']) fs.writeFileSync(path.join(p, t), '');
    await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; attention: { waiting: boolean } }[]).filter((s) => agents.includes(s.id) && s.attention.waiting).length, { timeout: 5000 }).toBe(3); // the tree is not drawn in edit mode
    // needs 107 (ticket 180): the strip fills its own zone beside the terminal, which keeps its size.
    await expect(app.locator('#waiting-strip .qcard')).toHaveCount(1);
    // Ticket 370 (f6568f12): the quiet project is drawn open from the start, so its head and first row stay; only the rows
    // under them change as the decision lines arrive. Ticket 1032: the Assistants head and its set-up row are tree-0 and 1.
    expect(unmoved(before, await boxes(app))).toEqual(['tree-4', 'tree-5', 'tree-6', 'strip']);
    expect(unmoved(zonesBefore, await zoneBoxes()).sort()).toEqual([]); // no zone, its label or the terminal moves
    expect(await target.evaluate((el) => el === document.activeElement)).toBe(true);
    if (cdp) {
      await cdp.send('Input.insertText', { text: '눈' });
      if (how === 'composer') await expect(target).toHaveValue('답장 눈');
      else await expect.poll(() => core.read(writer.id)).toContain('눈');
    }
    await expect(app.getByRole('toolbar', { name: 'Layout edit' })).toBeVisible();
  });

// V1A-46: the widget list and gallery messages arrive after the drawer opens and lengthen the 사용자 위젯 label; the
// "v1b: chat" note (removed by V1B-43) used to shrink for it and slide the cards after it about 22 px.
test('an outside change clears the undo history and says so, so Undo never erases a hand edit', async ({ app, core }) => {
  await openWindow(app);
  await edit(app);
  await dropOnEdge(app, 'waiting', 'right');
  await done(app);
  await expect.poll(() => read(core)).toContain('waiting-2');
  const hand = read(core).replace('size = 256', 'size = 300');
  fs.writeFileSync(file(core), hand);
  await expect(app.locator('.status .lnote')).toHaveText('layout.toml changed outside this window: undo history cleared');
  await expect.poll(async () => Math.round((await zone(app, 'tree').boundingBox())!.width)).toBe(300);
  await edit(app);
  await expect(app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: /^Undo/ })).toBeDisabled();
  await done(app);
  expect(read(core)).toBe(hand);
});

test('nunchiro layout goes to one window: the newest, or the one last worked in; undo steps back the file', async ({ app, core }) => {
  fs.rmSync(file(core)); // start from no file, so undo ends at the default
  await openWindow(app);
  const b = await secondWindow(app, core);
  // The window last worked in takes the command (the core tests cover "else the newest").
  await b.locator('footer.status').click();
  expect(core.cli('layout', 'edge', 'right', 'context').text).toBe('edge right context');
  await expect.poll(() => zones(b)).toContain('context');
  await expect.poll(() => zones(app)).toContain('context');
  // Working in a makes a the target; a is editing, so it refuses rather than another window guessing.
  await edit(app);
  expect(() => core.cli('layout', 'add', 'waiting')).toThrow(/editing the layout/);
  // Back in b: b takes it while a is still editing.
  await b.locator('footer.status').click();
  expect(core.cli('layout', 'add', 'waiting').type).toBe('text');
  await expect.poll(() => read(core)).toContain('widgets = ["waiting"]'); // the file header names every widget kind
  // Undo is the file's, not a window's: it works with a still editing and no window history involved.
  expect(core.cli('layout', 'undo').text).toBe('undo');
  await expect.poll(() => read(core)).not.toContain('widgets = ["waiting"]');
  expect(read(core)).toContain('widgets = ["context"]');
  // The first change is undone back to no file: the default layout.
  expect(core.cli('layout', 'undo').text).toBe('undo');
  expect(fs.existsSync(file(core))).toBe(false);
  expect(() => core.cli('layout', 'undo')).toThrow(/nothing to undo/);
  await app.getByRole('toolbar', { name: 'Layout edit' }).getByRole('button', { name: 'Cancel' }).click();
  // No waiting for the window to notice the undo: the command carries the file as it is now.
  core.cli('layout', 'reset');
  expect(read(core)).not.toContain('widgets = ["context"]');
  expect(read(core)).toContain('id = "centre"');
});

test('Done, then CLI undo at once: the window shows the undone layout and its next save does not restore it', async ({ app, core }) => {
  await openWindow(app);
  for (let run = 0; run < 4; run++) {
    await edit(app);
    // needs 153: the two zones are library drops (no typed line).
    await dropOnEdge(app, 'waiting', 'right');
    await dropOnEdge(app, 'waiting', 'left');
    await done(app);
    // Undo the moment the save is on disk, inside one 250 ms watch interval.
    await expect.poll(() => read(core), { intervals: [5] }).toContain('waiting-3');
    core.cli('layout', 'undo');
    // Done saved both zones as one step: undo takes the file back to before it, and the window follows.
    await expect.poll(() => zones(app)).not.toContain('waiting-3');
    expect(await zones(app)).not.toContain('waiting-2');
    // The window's next save (a gutter step) starts from the undone layout and must not bring the zones back.
    await nudge(app);
    await expect.poll(() => read(core)).toContain(`size = ${272 + 16 * run}`);
    expect(read(core)).not.toContain('waiting-2');
    expect(await zones(app)).not.toContain('waiting-2');
  }
});

test('zoom: prefix z fills the layout with the focused zone, again restores; layout.toml is untouched; edit mode unzooms', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  const bytes = read(core);
  const mtime = fs.statSync(file(core)).mtimeMs;
  const box = (await app.locator('.layout').boundingBox())!;
  const layout = { width: box.width - 6, height: box.height - 6 }; // the 3 px frame around the zones (D5b)
  await app.locator('.term').first().click();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyZ');
  await expect(zone(app, 'tree')).toBeHidden();
  await expect(zone(app, 'composer')).toBeHidden();
  const z = (await zone(app, 'terminal').boundingBox())!;
  expect(Math.abs(z.width - layout.width)).toBeLessThan(2);
  expect(Math.abs(z.height - layout.height)).toBeLessThan(2);
  await expect(app.locator('.zoom-note')).toHaveText('Zoomed · ◆ z');
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyZ');
  await expect(zone(app, 'tree')).toBeVisible();
  await expect(app.locator('.zoom-note')).toHaveCount(0);
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyZ');
  await expect(zone(app, 'tree')).toBeHidden();
  await edit(app);
  await expect(zone(app, 'tree')).toBeVisible();
  await expect(app.locator('.zoom-note')).toHaveCount(0);
  await app.waitForTimeout(400);
  expect(read(core)).toBe(bytes);
  expect(fs.statSync(file(core)).mtimeMs).toBe(mtime);
});

// V1A-43 pane mode: prefix r, then h j k l focus, Shift swaps, Control resizes (acceptance 14: focus is view state).
const pane = async (app: Page) => {
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyR');
};
const focused = (app: Page) => app.locator('[data-pane-focus="true"]');
const undoFromPalette = async (app: Page) => {
  await app.keyboard.press('Meta+KeyK');
  await app.getByRole('combobox', { name: 'Command palette search' }).fill('Undo layout change');
  await app.keyboard.press('Enter');
};

test('pane mode: status line, outline, hjkl moves focus without touching layout.toml, Esc leaves', async ({ app, core }) => {
  const seeded = read(core);
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator('.term').first().click();
  await pane(app);
  await expect(app.locator('.pane-status')).toHaveText('Pane mode · hjkl focus · ⇧ swap · ⌃ resize · esc leave');
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'terminal');
  await app.keyboard.press('KeyH');
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'tree');
  await app.keyboard.press('ArrowRight');
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'terminal');
  await app.keyboard.press('KeyK'); // nothing above the terminal: stays
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'terminal');
  // A Korean input source reports other characters; the physical code decides.
  await app.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', key: 'ㅗ', bubbles: true, cancelable: true })));
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'tree');
  await app.waitForTimeout(400);
  expect(read(core)).toBe(seeded); // pane mode never writes layout.toml
  await app.keyboard.press('Escape');
  await expect(focused(app)).toHaveCount(0);
  await expect(app.locator('.pane-status')).toHaveText('');
});

test('pane mode keys never reach the focused input, and Enter and q leave', async ({ app }) => {
  await openWindow(app);
  const box = app.getByRole('textbox').last();
  await box.focus();
  await pane(app);
  // Keys aimed at the input itself (a terminal's textarea is the same case) must stop at the window.
  const reached = await box.evaluate((el) => {
    let n = 0;
    el.addEventListener('keydown', () => n++);
    for (const code of ['KeyL', 'KeyX', 'Digit1']) el.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    return n;
  });
  expect(reached).toBe(0);
  // A composing key (macOS Korean reports one for every key) is held back too.
  const composed = await box.evaluate((el) => {
    let n = 0;
    el.addEventListener('keydown', () => n++);
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', isComposing: true, bubbles: true, cancelable: true }));
    return n;
  });
  expect(composed).toBe(0);
  await app.keyboard.press('Enter');
  await expect(focused(app)).toHaveCount(0);
  await pane(app);
  await app.keyboard.press('KeyQ');
  await expect(focused(app)).toHaveCount(0);
});

for (const leave of ['Escape', 'Enter', 'KeyQ']) {
  test(`pane mode: ${leave} leaves with the picked zone focused; with no move the old focus returns`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    await openWindow(app);
    const composer = app.getByRole('textbox').last();
    await composer.focus();
    await pane(app);
    await app.keyboard.press('KeyK'); // composer -> the zone above it
    const picked = await focused(app).getAttribute('data-zone-id');
    expect(picked).not.toBe('composer');
    await app.keyboard.press(leave);
    await expect(focused(app)).toHaveCount(0);
    expect(await app.evaluate(() => document.activeElement?.closest('[data-zone-id]')?.getAttribute('data-zone-id') ?? null)).toBe(picked);
    // No move: the element focused before entry gets focus back.
    await composer.focus();
    await pane(app);
    await app.keyboard.press(leave);
    await expect(composer).toBeFocused();
  });
}

test('pane mode: Shift+h swaps the focused zone with its neighbour once; Undo restores; focus follows', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator('.term').first().click();
  await pane(app);
  await app.keyboard.press('Shift+KeyH');
  await expect.poll(() => read(core)).toContain('widgets = ["terminal"]');
  await expect(focused(app)).toHaveAttribute('data-zone-id', 'tree');
  // Zone ids stay: the terminal widget now sits in the old tree zone, and the tree widget in the terminal zone.
  await expect(zone(app, 'tree').locator('[data-widget="terminal"]')).toBeVisible();
  const after = read(core);
  await app.keyboard.press('Escape');
  await undoFromPalette(app);
  await expect.poll(() => read(core)).not.toBe(after);
  await expect(zone(app, 'terminal').locator('[data-widget="terminal"]')).toBeVisible();
});

test('pane mode: Control+l grows the zone by one step, Control+h shrinks it, and it stops at the minimum', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator('.term').first().click();
  await pane(app);
  await app.keyboard.press('KeyH'); // tree: inside the 256 px left column
  const w0 = (await zone(app, 'tree').boundingBox())!.width;
  await app.keyboard.press('Control+KeyL');
  await expect.poll(async () => Math.round((await zone(app, 'tree').boundingBox())!.width)).toBe(Math.round(w0) + 16);
  await expect.poll(() => read(core)).toContain('size = 272');
  for (let i = 0; i < 20; i++) await app.keyboard.press('Control+KeyH');
  await expect.poll(async () => Math.round((await zone(app, 'tree').boundingBox())!.width)).toBe(200); // context minimum width
  await app.waitForTimeout(300); // let the queued saves land before taking the baseline
  const bytes = read(core);
  await app.keyboard.press('Control+KeyH');
  await app.waitForTimeout(300);
  expect(read(core)).toBe(bytes);
});


test('pane mode: zoom ends when it starts, and edit mode refuses it', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await app.locator('.term').first().click();
  await app.keyboard.press('Control+Space');
  await app.keyboard.press('KeyZ');
  await expect(zone(app, 'tree')).toBeHidden();
  await pane(app);
  await expect(zone(app, 'tree')).toBeVisible();
  await expect(focused(app)).toHaveCount(1);
  await app.keyboard.press('Escape');
  await edit(app);
  await pane(app);
  await expect(focused(app)).toHaveCount(0);
});
