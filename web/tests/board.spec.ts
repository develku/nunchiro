// Board widget (ticket 16; spec-v1b B4, Acceptance 11 window half; needs 3, 26). Every test runs a real core with its
// own NUNCHIRO_HOME under .scratch, so board.toml, board.json and layout.toml are never the user's.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { Core, expect, openWindow, REPO, test, showComposer } from './fixtures';
// Ticket 1090: a session is in the Working column only while it is in a turn; a quiet `cat` shell is not.
import { busyShell } from './fixtures/board/coord';

const FIXTURES = path.join(import.meta.dirname, 'fixtures/board');
const BIN = path.join(REPO, 'target/debug/nunchiro');
const toml = (core: Core) => path.join(core.home, 'board.toml');

/** The default layout with the board above a short terminal (written before the window opens). */
function placeBoard(core: Core) {
  fs.copyFileSync(path.join(FIXTURES, 'layout.toml'), path.join(core.home, 'layout.toml'));
}
const titles = (page: Page) => page.$$eval('.board .bch b', (els) => els.map((e) => e.textContent));
/** Card titles shown in one column, top to bottom. */
const cardsIn = (page: Page, column: string) => page.$$eval(`.board [data-column="${column}"] .bcard .btt`, (els) => els.map((e) => e.textContent));
const card = (page: Page, title: string) => page.locator('.board .bcard').filter({ has: page.locator('.btt', { hasText: new RegExp(`^${title}$`) }) });

/** A shell session whose one finished turn is unseen (state review), through the real hook bridge. */
function reviewSession(core: Core, project: string, label: string) {
  const script = `printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`;
  return core.shell(project, label, '/bin/sh', '-c', script);
}

async function newCard(page: Page, title: string, column?: string) {
  await page.locator('.board').getByRole('button', { name: '+ Card' }).click();
  const dialog = page.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill(title);
  if (column) await dialog.getByLabel('Column').selectOption(column);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(card(page, title)).toBeVisible();
}

test('board default columns and session cards', async ({ app, core }) => {
  placeBoard(core);
  const p = core.project('demo');
  busyShell(core, p, 'busy');
  const waiting = core.agent(p, 'asks', 'go');
  reviewSession(core, p, 'finished');
  core.shell(p, 'gone', '/bin/sh', '-c', 'exit 0');
  fs.writeFileSync(path.join(waiting.cwd, 'go'), '');
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await expect.poll(() => cardsIn(app, 'working'), { timeout: 15_000 }).toEqual(['busy']);
  await expect.poll(() => cardsIn(app, 'needs-decision'), { timeout: 15_000 }).toEqual(['asks']);
  await expect.poll(() => cardsIn(app, 'review'), { timeout: 15_000 }).toEqual(['finished']);
  await expect.poll(() => cardsIn(app, 'done'), { timeout: 15_000 }).toEqual(['gone']);
  // Fresh install: the defaults come from the core; nothing writes board.toml.
  expect(fs.existsSync(toml(core))).toBe(false);
  // Clicking a session card focuses that session.
  await card(app, 'busy').click();
  await expect(app.locator('.tab[aria-selected="true"]')).toContainText('busy');
});

test('board hand edit reloads', async ({ app, core }) => {
  placeBoard(core);
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  const hand = fs.readFileSync(path.join(FIXTURES, 'hand.toml'), 'utf8');
  fs.writeFileSync(toml(core), hand);
  // One poll is one second; allow one more for a busy machine.
  await expect.poll(() => titles(app), { timeout: 2_500 }).toEqual(['할 일', '진행 중', '사람 확인', '끝']);
  await expect(app.locator('.board [data-column="todo"] .bnd')).toHaveCount(0);
  await expect(app.locator('.board [data-column="human"] .bnd')).toBeVisible();
  // An invalid edit names the line and keeps the last good board.
  fs.writeFileSync(toml(core), hand.replace('title = "진행 중"', 'title = 3'));
  await expect(app.locator('.board .bmsg')).toContainText('board.toml has a problem on line 10.', { timeout: 2_500 });
  await expect(app.locator('.board .bmsg')).toContainText('keeping the last good board');
  expect(await titles(app)).toEqual(['할 일', '진행 중', '사람 확인', '끝']);
  // Fixing it clears the error.
  fs.writeFileSync(toml(core), hand);
  await expect(app.locator('.board .bmsg')).toHaveText('', { timeout: 2_500 });
});

const columnsDialog = async (page: Page) => {
  await page.locator('.board').getByRole('button', { name: 'Columns' }).click();
  return page.getByRole('dialog', { name: 'Columns' });
};
async function rename(page: Page, n: number, title: string) {
  const dialog = page.getByRole('dialog', { name: 'Columns' });
  await dialog.getByLabel(`Title of column ${n}`).fill(title);
  await dialog.getByLabel(`Title of column ${n}`).press('Enter');
}

test('board gui column edit writes toml', async ({ app, core }) => {
  placeBoard(core);
  fs.copyFileSync(path.join(FIXTURES, 'gui.toml'), toml(core));
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['작업 중', '결정 필요', '검토', '완료']);
  const dialog = await columnsDialog(app);
  await rename(app, 3, '리뷰 대기');
  const renamed = fs.readFileSync(path.join(FIXTURES, 'gui-renamed.toml'), 'utf8');
  // Only the edited column's bytes change: comments, spacing, key order and [sources] stay.
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toBe(renamed);
  await expect.poll(() => titles(app)).toEqual(['작업 중', '결정 필요', '리뷰 대기', '완료']);
  // Add, mark, take a state, reorder, then delete the new column: the file is back to the rename alone.
  await dialog.getByRole('button', { name: '+ Add column' }).click();
  await expect.poll(() => titles(app)).toEqual(['작업 중', '결정 필요', '리뷰 대기', '완료', 'Column 5']);
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('[[columns]]\nid = "column-5"\ntitle = "Column 5"\n\n[sources]');
  await dialog.locator('[data-column-row="column-5"] > label input').click();
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('id = "column-5"\ntitle = "Column 5"\nneeds_decision = true\n');
  await dialog.getByRole('button', { name: 'Move column 5 left' }).click();
  await expect.poll(() => titles(app)).toEqual(['작업 중', '결정 필요', '리뷰 대기', 'Column 5', '완료']);
  await dialog.getByRole('button', { name: 'Delete column 4' }).click();
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toBe(renamed);
  // Taking a state another column holds moves it.
  await dialog.locator('[data-column-row="working"]').getByLabel('done').click();
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('id = "done"\ntitle = "완료"   # trailing\nstates = []\n');
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain("title = \"작업 중\"   # keep this comment\nid = 'working'\nstates = [\"working\", \"done\"]\n");
});

test('board first gui edit creates board.toml 0600 from the defaults plus the change', async ({ app, core }) => {
  placeBoard(core);
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  await columnsDialog(app);
  await rename(app, 1, '진행');
  await expect.poll(() => fs.existsSync(toml(core))).toBe(true);
  expect(fs.statSync(toml(core)).mode & 0o777).toBe(0o600);
  const text = fs.readFileSync(toml(core), 'utf8');
  expect(text).toContain('id = "todo"\ntitle = "진행"\n\n');
  expect(text).toContain('id = "needs-decision"\ntitle = "Needs decision"\nstates = ["needs_decision"]\nneeds_decision = true\n');
  await expect.poll(() => titles(app)).toEqual(['진행', 'Working', 'Needs decision', 'Review', 'Done']);
});

test('board two windows editing columns: the second gets the conflict refusal', async ({ app, core }) => {
  placeBoard(core);
  fs.copyFileSync(path.join(FIXTURES, 'gui.toml'), toml(core));
  await openWindow(app);
  const other = await app.context().newPage();
  await other.addInitScript((boot) => (window.__NUNCHIRO__ = boot), core.boot());
  await openWindow(other, {}, core);
  for (const p of [app, other]) await expect.poll(() => titles(p)).toEqual(['작업 중', '결정 필요', '검토', '완료']);
  // The second window opens its editor (focus inside holds its board), then the first one writes.
  await columnsDialog(other);
  await other.getByLabel('Title of column 2').focus();
  await columnsDialog(app);
  await rename(app, 1, '첫 창');
  await expect.poll(() => fs.readFileSync(toml(core), 'utf8')).toContain('title = "첫 창"');
  await rename(other, 2, '둘째 창');
  await expect(other.locator('.board .bmsg')).toHaveText('board.toml was changed elsewhere and has been reloaded. Make your change again.'); // ticket 551: the plain line
  await expect(other.getByRole('dialog', { name: 'Columns' }).getByRole('alert')).toContainText('board.toml was changed elsewhere and has been reloaded.');
  const text = fs.readFileSync(toml(core), 'utf8');
  expect(text).toContain('title = "첫 창"');
  expect(text).not.toContain('둘째 창');
  // The refused window now shows the file as it is.
  await expect.poll(() => titles(other)).toEqual(['첫 창', '결정 필요', '검토', '완료']);
  await other.close();
});

async function dragTo(page: Page, from: ReturnType<Page['locator']>, to: { x: number; y: number }) {
  const b = (await from.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(page.locator('.board .bghost')).toBeVisible();
  await page.mouse.up();
}
/** The point midway between two stacked cards. */
async function between(page: Page, a: string, b: string) {
  const [ra, rb] = [(await card(page, a).boundingBox())!, (await card(page, b).boundingBox())!];
  return { x: ra.x + ra.width / 2, y: (ra.y + ra.height + rb.y) / 2 };
}

test('board drag places card', async ({ app, core }) => {
  placeBoard(core);
  busyShell(core, core.project('demo'), 'busy');
  await openWindow(app);
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['busy']);
  for (const t of ['A', 'B', 'C']) await newCard(app, t, 'review');
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['A', 'B', 'C']);
  // Manual card between two cards.
  await dragTo(app, card(app, 'C'), await between(app, 'A', 'B'));
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['A', 'C', 'B']);
  // Session card into an empty column; the core holds it there across polls.
  const empty = (await app.locator('.board [data-column="done"] .bcards').first().boundingBox())!; // V2.5-37: one cell per lane
  await dragTo(app, card(app, 'busy'), { x: empty.x + empty.width / 2, y: empty.y + 20 });
  await expect.poll(() => cardsIn(app, 'done')).toEqual(['busy']);
  await app.mouse.move(5, 5);
  await app.waitForTimeout(1_500);
  expect(await cardsIn(app, 'done')).toEqual(['busy']);
  expect(await cardsIn(app, 'working')).toEqual([]);
  // A manual card into another column, between nothing: the core stores its column.
  const decision = (await app.locator('.board [data-column="needs-decision"] .bcards').first().boundingBox())!; // V2.5-37: one cell per lane
  await dragTo(app, card(app, 'B'), { x: decision.x + decision.width / 2, y: decision.y + 20 });
  await expect.poll(() => cardsIn(app, 'needs-decision')).toEqual(['B']);
  await app.mouse.move(5, 5);
  await app.waitForTimeout(1_500);
  expect(await cardsIn(app, 'needs-decision')).toEqual(['B']);
  // Release outside any column cancels.
  const term = (await app.locator('[data-zone-id="terminal"]').boundingBox())!;
  await dragTo(app, card(app, 'A'), { x: term.x + term.width / 2, y: term.y + term.height / 2 });
  expect(await cardsIn(app, 'review')).toEqual(['A', 'C']);
  // The keyboard path gives the drag's result: B back between A and C, by drag, then undone and redone by keys.
  await dragTo(app, card(app, 'B'), await between(app, 'A', 'C'));
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['A', 'B', 'C']);
  const dragged = await cardsIn(app, 'review');
  // V2.5-37: a task card's tab stop is its title button (its ref, chips and history are siblings).
  await card(app, 'B').locator('.bmain').focus();
  await app.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => cardsIn(app, 'needs-decision')).toEqual(['B']);
  await expect(card(app, 'B').locator('.bmain')).toBeFocused();
  await app.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['B', 'A', 'C']);
  await app.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => cardsIn(app, 'review')).toEqual(dragged);
  await app.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['B', 'A', 'C']);
  // Session cards move by keys too.
  await card(app, 'busy').focus();
  await app.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => cardsIn(app, 'review')).toEqual(['busy', 'B', 'A', 'C']);
});

test('board no network beyond core', async ({ app, core }) => {
  placeBoard(core);
  busyShell(core, core.project('demo'), 'busy');
  const requests: string[] = [];
  const sockets: string[] = [];
  app.on('request', (r) => requests.push(r.url()));
  app.on('websocket', (ws) => sockets.push(ws.url()));
  await openWindow(app);
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['busy']);
  requests.length = 0;
  await newCard(app, 'offline', 'review');
  await dragTo(app, card(app, 'offline'), await (async () => {
    const r = (await app.locator('.board [data-column="done"] .bcards').first().boundingBox())!; // V2.5-37: one cell per lane
    return { x: r.x + r.width / 2, y: r.y + 20 };
  })());
  await columnsDialog(app);
  await rename(app, 1, '진행');
  await expect.poll(() => fs.existsSync(toml(core))).toBe(true);
  await app.waitForTimeout(1_500);
  expect(requests).toEqual([]);
  expect(sockets.length).toBeGreaterThan(0);
  for (const url of sockets) expect(url).toBe(`ws://127.0.0.1:${core.boot().port}/ws`);
  // And no code path for it: the board module has no fetch, beacon, XHR, socket or dynamic import of its own.
  const dir = path.join(REPO, 'web/src/board');
  for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/fetch\(|sendBeacon|XMLHttpRequest|new WebSocket|import\(|<img|EventSource/);
});

test('board update keeps boxes under pointer', async ({ app, core }) => {
  placeBoard(core);
  const p = core.project('demo');
  busyShell(core, p, 'first');
  await openWindow(app);
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['first']);
  const boxes = () => app.$$eval('.board .bcard, .board .bch, .board .bhead button, .board .bproj', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); }));
  await card(app, 'first').hover();
  const before = await boxes();
  busyShell(core, p, 'second');
  busyShell(core, p, 'third');
  await expect(app.locator('.board .bnew')).toHaveText('new 2', { timeout: 5_000 });
  expect(await boxes()).toEqual(before);
  expect(await cardsIn(app, 'working')).toEqual(['first']);
  // Focus inside holds too, after the pointer leaves.
  await card(app, 'first').focus();
  await app.mouse.move(5, 5);
  await app.waitForTimeout(1_200);
  expect(await boxes()).toEqual(before);
  // Leaving with both shows the held arrivals.
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  // Arrivals seen in the same poll have no order between them; earlier cards keep theirs.
  await expect.poll(async () => (await cardsIn(app, 'working')).map((t, i) => (i ? 'later:' + t : t)).sort()).toEqual(['first', 'later:second', 'later:third']);
  expect((await cardsIn(app, 'working'))[0]).toBe('first');
  await expect(app.locator('.board .bnew')).toHaveText('');
});

test('board column title of 256 bytes of Hangul fits without widening the widget', async ({ app, core }) => {
  placeBoard(core);
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  const widget = (await app.locator('.board').boundingBox())!;
  const long = `${'가'.repeat(85)}X`; // 85 × 3 bytes + 1 = 256 bytes
  expect(Buffer.byteLength(long)).toBe(256);
  fs.writeFileSync(toml(core), `version = 1\n[[columns]]\nid = "long"\ntitle = "${long}"\nstates = ["working", "needs_decision", "review", "done"]\n`);
  await expect.poll(() => titles(app), { timeout: 2_500 }).toEqual([long]);
  expect(await app.locator('.board').boundingBox()).toEqual(widget);
  expect((await app.locator('.board .bcol').boundingBox())!.width).toBeLessThanOrEqual(widget.width); // CHROME: columns fill the board (no 360 px cap)
  await expect(app.locator('.board .bch b')).toHaveAttribute('title', long);
});

test('board manual card Hangul IME: Enter during composition does not submit', async ({ app, core, browserName }) => {
  placeBoard(core);
  await openWindow(app);
  await app.locator('.board').getByRole('button', { name: '+ Card' }).click();
  const dialog = app.getByRole('dialog', { name: 'New card' });
  const title = dialog.getByLabel('Title');
  await title.focus();
  const cdp = browserName === 'chromium' ? await app.context().newCDPSession(app) : null;
  if (cdp) {
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '한' });
    await cdp.send('Input.imeSetComposition', { text: '글', selectionStart: 1, selectionEnd: 1 });
  } else await app.keyboard.insertText('한글');
  // The Enter that commits a syllable (isComposing; Safari reports keyCode 229) must not save.
  await title.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true } as KeyboardEventInit));
  });
  if (cdp) await cdp.send('Input.insertText', { text: '글' });
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue('한글');
  const note = dialog.getByLabel('Note');
  await note.focus();
  if (cdp) {
    await cdp.send('Input.imeSetComposition', { text: '메', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '메모' });
  } else await app.keyboard.insertText('메모');
  await expect(note).toHaveValue('메모');
  await title.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(card(app, '한글')).toContainText('메모');
  // Edit and delete.
  await card(app, '한글').click();
  const edit = app.getByRole('dialog', { name: 'Edit card' });
  await edit.getByLabel('Title').fill('고친 제목');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(card(app, '고친 제목')).toBeVisible();
  await card(app, '고친 제목').click();
  await app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Delete' }).click();
  await expect(app.locator('.board .bcard')).toHaveCount(0);
});

/** A keydown as a Korean input source produces it: the physical code with a Hangul key value. */
const physical = (page: Page, init: { code: string; key: string; ctrlKey?: boolean; keyCode?: number }) =>
  page.evaluate((i) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i })), init);

test('board prefix keys and hints reach cards with a Korean input source', async ({ app, core }) => {
  placeBoard(core);
  const p = core.project('demo');
  const one = busyShell(core, p, 'one');
  busyShell(core, p, 'two');
  await openWindow(app);
  await expect.poll(async () => (await cardsIn(app, 'working')).sort()).toEqual(['one', 'two']);
  await app.locator('.tab', { hasText: 'two' }).click();
  await card(app, 'one').focus();
  // Prefix then f, as a Korean source sends them (keyCode 229, key "Process").
  await physical(app, { code: 'Space', key: 'Process', ctrlKey: true, keyCode: 229 });
  await expect(app.locator('.prefix-armed')).toBeVisible();
  await physical(app, { code: 'KeyF', key: 'Process', keyCode: 229 });
  const hint = await app.locator('.hint[data-kind="element"]').evaluateAll((hs) => {
    const c = [...document.querySelectorAll('.board .bcard')].find((e) => e.textContent?.includes('one'))!.getBoundingClientRect();
    return hs.find((h) => Math.abs(h.getBoundingClientRect().left - c.left) < 1 && Math.abs(h.getBoundingClientRect().top - c.top) < 1)?.getAttribute('data-keys');
  });
  expect(hint).toBeTruthy();
  // Ticket 389: labels are letters; with Korean input on the key is Process and its QWERTY code stands in.
  for (const k of hint!.split(' ')) await physical(app, { code: (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), key: 'Process', keyCode: 229 });
  await expect(app.locator('.hint')).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', one.id);
  // Alt+arrow moves a focused card with a Korean source too.
  await card(app, 'one').focus();
  await physical(app, { code: 'ArrowRight', key: 'ArrowRight', keyCode: 229, altKey: true } as never);
  await expect.poll(() => cardsIn(app, 'needs-decision')).toEqual(['one']);
});

test('board 200 cards in one column scroll inside the column without resizing the widget', async ({ app, core }) => {
  placeBoard(core);
  const columns = [
    ['working', '작업 중', 'working', false],
    ['needs-decision', '결정 필요', 'needs_decision', true],
    ['review', '검토', 'review', false],
    ['done', '완료', 'done', false],
  ].map(([id, title, state, needs_decision]) => ({ id, title, states: [state], needs_decision }));
  const manual = Array.from({ length: 200 }, (_, i) => ({ id: `card-${i}`, title: `카드 ${i}`, note: '', session_id: null, column: 'review', updated_at: i + 1 }));
  fs.writeFileSync(path.join(core.home, 'board.json'), JSON.stringify({ version: 1, columns, config_stamp: null, config_error: null, manual }));
  await openWindow(app);
  await expect(app.locator('.board [data-column="review"] .bcard')).toHaveCount(200);
  const widget = (await app.locator('.board').boundingBox())!;
  const zone = (await app.locator('[data-zone-id="board"]').boundingBox())!;
  expect(widget.height).toBeLessThanOrEqual(zone.height);
  const list = app.locator('.board .bcols'); // V2.5-37 (draft B .bw): the board grid scrolls, lanes and columns together
  const sizes = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(card(app, '카드 199')).toBeInViewport();
  expect(await app.locator('.board').boundingBox()).toEqual(widget);
});

test('board card linked to a closed session still renders; opening a review session marks it seen', async ({ app, core }) => {
  placeBoard(core);
  const p = core.project('demo');
  const gone = core.shell(p, 'gone');
  const finished = reviewSession(core, p, 'finished');
  await openWindow(app);
  await expect.poll(() => cardsIn(app, 'review'), { timeout: 15_000 }).toEqual(['finished']);
  await newCard(app, 'linked');
  await card(app, 'linked').click();
  const edit = app.getByRole('dialog', { name: 'Edit card' });
  await edit.getByLabel('Session').selectOption({ label: 'gone' });
  await edit.getByRole('button', { name: 'Save' }).click();
  core.windowClose(gone.id); // ticket 1013 F6: the window's own Close keeps the done tab
  // Pointer and focus out, so the board is not holding.
  await app.mouse.move(5, 5);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  await expect.poll(() => cardsIn(app, 'done'), { timeout: 10_000 }).toEqual(['gone']);
  await expect(card(app, 'linked')).toBeVisible();
  await card(app, 'linked').click();
  await expect(app.getByRole('dialog', { name: 'Edit card' }).getByLabel('Session')).toHaveValue(gone.id);
  await app.getByRole('dialog', { name: 'Edit card' }).getByRole('button', { name: 'Cancel' }).click();
  // Opening the review session sends board_seen: its finished turn is now done.
  await card(app, 'finished').click();
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', finished.id);
  await app.mouse.move(5, 5);
  await showComposer(app); // V2.5-34: a shell's composer is asked for
  await app.locator('.cbox textarea').focus();
  await expect.poll(async () => (await cardsIn(app, 'done')).sort(), { timeout: 5_000 }).toEqual(['finished', 'gone']);
});

// ticket 219 / needs 178 L10, needs 185: the project filter is a searchable picker (a trigger and a listbox), not a native select.
const pickProject = async (app: Page, name: string) => {
  await app.locator('button.bproj').click();
  await app.getByRole('option', { name, exact: true }).click();
};

test('board project filter chip shows one project or all', async ({ app, core }) => {
  placeBoard(core);
  busyShell(core, core.project('alpha'), 'in-alpha');
  busyShell(core, core.project('beta'), 'in-beta');
  await openWindow(app);
  await expect.poll(async () => (await cardsIn(app, 'working')).sort()).toEqual(['in-alpha', 'in-beta']);
  await pickProject(app, 'beta');
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['in-beta']);
  await app.reload();
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['in-beta']);
  await pickProject(app, 'All projects');
  await expect.poll(async () => (await cardsIn(app, 'working')).sort()).toEqual(['in-alpha', 'in-beta']);
});

test('board gui write while board.toml is invalid is refused with the line error', async ({ app, core }) => {
  placeBoard(core);
  const bad = 'version = 1\n[[columns]]\nid = "a"\ntitle = 3\n';
  fs.writeFileSync(toml(core), bad);
  await openWindow(app);
  await expect(app.locator('.board .bmsg')).toContainText('board.toml has a problem on line 4.');
  await columnsDialog(app);
  await rename(app, 1, '바꿈');
  await expect(app.getByRole('dialog', { name: 'Columns' }).getByRole('alert')).toContainText('board.toml has a problem on line 4.');
  expect(fs.readFileSync(toml(core), 'utf8')).toBe(bad);
});

test('board columns share the width at 1440; at 640x480 New card Save and Columns stay reachable', async ({ app, core }) => {
  placeBoard(core);
  await openWindow(app);
  await expect.poll(() => titles(app)).toEqual(['To do', 'Working', 'Needs decision', 'Review', 'Done']);
  // Review r1: four columns no longer leave the right of the board empty.
  const cols = app.locator('.board .bcols');
  const last = (await app.locator('.board .bcol').last().boundingBox())!;
  const area = (await cols.boundingBox())!;
  expect(Math.round(area.x + area.width - (last.x + last.width))).toBeLessThanOrEqual(12); // V2.5-37: five 1fr tracks round to 1/64 px; CHROME: 12 px board padding (frame-ko-e .bwrap)
  await app.setViewportSize({ width: 640, height: 480 });
  const board = (await app.locator('.board').boundingBox())!;
  const columns = (await app.locator('.board').getByRole('button', { name: 'Columns' }).boundingBox())!;
  expect(columns.x + columns.width).toBeLessThanOrEqual(board.x + board.width);
  await app.locator('.board').getByRole('button', { name: '+ Card' }).click();
  const dialog = app.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill('작은 창');
  const save = dialog.getByRole('button', { name: 'Save' });
  const box = (await save.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(480);
  // Nothing in the dialog overlaps: the Column and Session row sits above the buttons.
  const pick = (await dialog.getByLabel('Session').boundingBox())!;
  expect(pick.y + pick.height).toBeLessThanOrEqual(box.y);
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(card(app, '작은 창')).toHaveCount(1);
  await app.locator('.board').getByRole('button', { name: 'Columns' }).click();
  await expect(app.getByRole('dialog', { name: 'Columns' }).getByRole('button', { name: '+ Add column' })).toBeInViewport();
});

test('board marks a turn seen when it finishes on the session already in view', async ({ app, core }) => {
  placeBoard(core);
  const p = core.project('demo');
  // Ticket 1090: in a turn from the start (working only in a turn), finished once `go` exists.
  const script = `printf '{}' | '${BIN}' hook UserPromptSubmit; while [ ! -f go ]; do sleep 0.05; done; printf '{}' | '${BIN}' hook Stop; exec cat`;
  const s = core.shell(p, 'in-view', '/bin/sh', '-c', script);
  await openWindow(app);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', s.id);
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['in-view']);
  fs.writeFileSync(path.join(p, 'go'), '');
  // The turn finishes while its tab is open: the window sends board_seen, so the card goes to 완료, not 검토.
  await expect.poll(() => cardsIn(app, 'done'), { timeout: 10_000 }).toEqual(['in-view']);
  // Held there across polls: the core recorded the seen marker, it is not a window-side overlay.
  await app.reload();
  await expect.poll(() => cardsIn(app, 'done')).toEqual(['in-view']);
});

test('board new N counts held column changes and skips cards the filter hides', async ({ app, core }) => {
  placeBoard(core);
  const alpha = core.project('alpha');
  const beta = core.project('beta');
  const first = busyShell(core, alpha, 'first');
  busyShell(core, beta, 'other');
  await openWindow(app);
  await expect.poll(async () => (await cardsIn(app, 'working')).sort()).toEqual(['first', 'other']);
  await pickProject(app, 'alpha');
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['first']);
  await card(app, 'first').hover();
  busyShell(core, beta, 'hidden');
  await app.waitForTimeout(1_500);
  await expect(app.locator('.board .bnew')).toHaveText('');
  busyShell(core, alpha, 'second');
  await expect(app.locator('.board .bnew')).toHaveText('new 1', { timeout: 5_000 });
  core.windowClose(first.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator('.board .bnew')).toHaveText('new 2', { timeout: 5_000 });
  expect(await cardsIn(app, 'working')).toEqual(['first']);
});

test('board shows a board.toml error even while the view is held', async ({ app, core }) => {
  placeBoard(core);
  busyShell(core, core.project('demo'), 'busy');
  await openWindow(app);
  await expect.poll(() => cardsIn(app, 'working')).toEqual(['busy']);
  await card(app, 'busy').hover();
  await card(app, 'busy').focus();
  fs.writeFileSync(toml(core), 'version = 1\n[[columns]]\nid = "a"\ntitle = 3\n');
  await expect(app.locator('.board .bmsg')).toContainText('board.toml has a problem on line 4.', { timeout: 2_500 });
  await expect(app.locator('.board')).toHaveAttribute('data-held', 'true');
});

test('board_seen is sent for the session in view even with no Board widget placed', async ({ app, core }) => {
  // Default layout: no board. The core keeps the board state, so the window marks the turn seen anyway.
  const p = core.project('demo');
  const script = `while [ ! -f go ]; do sleep 0.05; done; printf '{}' | '${BIN}' hook UserPromptSubmit; printf '{}' | '${BIN}' hook Stop; exec cat`;
  const s = core.shell(p, 'no-board', '/bin/sh', '-c', script);
  await openWindow(app);
  await expect(app.locator('.board')).toHaveCount(0);
  await expect(app.locator('.tab[aria-selected="true"]')).toHaveAttribute('data-tab', s.id);
  fs.writeFileSync(path.join(p, 'go'), '');
  const seen = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(core.home, 'board.json'), 'utf8')).seen?.[s.id] ?? 0;
    } catch {
      return 0;
    }
  };
  await expect.poll(seen, { timeout: 10_000 }).toBe(1);
});

test('columns_dialog_checkboxes_are_the_kit_box: the Columns dialog\'s boxes take the control colour, not the UA blue (look v35 b S3-4)', async ({ app, core }) => {
  placeBoard(core);
  await openWindow(app);
  const dialog = await columnsDialog(app);
  const boxes = dialog.locator('input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible();
  const want = await app.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.color = 'var(--control-bg)';
    document.querySelector('.board')!.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const got = await boxes.evaluateAll((els) => els.map((e) => getComputedStyle(e).accentColor));
  expect(got.length).toBeGreaterThan(0);
  expect(new Set(got)).toEqual(new Set([want]));
  for (const scheme of ['light', 'dark'] as const) {
    await app.emulateMedia({ colorScheme: scheme });
    await app.waitForTimeout(200);
    await dialog.screenshot({ path: path.join(REPO, `.scratch/shots/w108-s3-4-columns-${scheme}-${test.info().project.name}.png`) });
  }
});
