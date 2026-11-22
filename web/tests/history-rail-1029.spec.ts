// Ticket 1029 (mockup docs/design/history-1121, direction A): History rows in the tree's language. A hollow rail, the
// agent's icon, the name in bold with the run's start and length, one muted line with the project; a failed row has a
// red rail and the x-circle, a stopped one the grey stop mark. Three hover icons replace the text buttons. As a wide
// tab each session is one row whose columns line up, with a hollow run-length bar.
// Lane w59 (owner 11-21: the widget was below the mockup): the mockup's filter row (project list, agent segment, the
// stopped-or-failed toggle, the count), its short lengths ("18m"), a second line that is never the name again, its empty
// states, and the tab's head in one row. `mockup_side_by_side` draws the mockup's own ten sessions and leaves the shots
// that .scratch/compare/pair.mjs sets beside the mockup's.
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, openWindow, REPO, test, type Core } from './fixtures';
import * as words from '../src/i18n/areas/history';
import { patchSnapshots } from './tree-mock-states';

// Shots at two device pixels a point, as the mockup's renders (.scratch/compare/mock.mjs) and the owner's screen.
test.use({ deviceScaleFactor: 2 });
const SHOTS = path.join(REPO, '.scratch/shots');
const COMPARE = path.join(REPO, '.scratch/compare');
type Snap = { id: string; label: string; state: string };
const snap = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const ACTIONS = ['View conversation', 'Continue', 'View changes'];

/** One live shell and three finished ones in `demo`: `quick` ended by itself, `boom` failed, `halt` was closed. */
async function three(app: Page, core: Core) {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  const quick = core.shell(dir, 'quick', '/usr/bin/true').id;
  const boom = core.shell(dir, 'boom', '/usr/bin/true').id;
  const halt = core.shell(dir, 'halt').id;
  core.cli('session', 'close', halt);
  await expect.poll(() => [quick, boom, halt].map((id) => snap(core).find((s) => s.id === id)?.state)).toEqual(['exited', 'exited', 'closed']);
  const set = await patchSnapshots(app);
  set({ boom: { failed: true } });
  return { quick, boom, halt, dir };
}
const openHistory = (app: Page) => app.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'History', exact: true }).click();
/** What a token paints as, read from the page (the rows use tokens only, no colour of their own). */
const token = (app: Page, name: string) =>
  app.evaluate((n) => {
    const p = document.body.appendChild(document.createElement('i'));
    p.style.color = `var(${n})`;
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }, name);
const paint = (app: Page, sel: string) =>
  app.locator(sel).evaluate((e) => {
    const c = getComputedStyle(e);
    return { line: c.borderTopColor, fill: c.backgroundColor };
  });
const HOLLOW = 'rgba(0, 0, 0, 0)';

test('history_rail_rows: a row is a hollow rail, the agent icon, the bold name with start and length, and one muted line with the project', async ({ app, core }) => {
  const { quick, boom, halt } = await three(app, core);
  await openWindow(app);
  await openHistory(app);
  await app.locator('.sbar[data-widget="history"]').evaluate((e) => void ((e as HTMLElement).style.width = '320px'));
  const hist = app.locator('[data-history-view]');
  for (const scheme of ['dark', 'light'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await app.mouse.move(600, 500);
    const row = (id: string) => hist.locator(`[data-history="${id}"]`);
    await expect(hist.locator('[data-history]')).toHaveCount(3);
    // The day's head: its word, its date and the count as the tree's hollow bar with a number.
    await expect(hist.locator('.histv-day b')).toHaveText('Today');
    await expect(hist.locator('.histv-day .dbar .num')).toHaveText('3');
    // Row content.
    await expect(row(quick).locator('.hr-go b')).toHaveText('quick');
    await expect(row(quick).locator('.hr-ag [data-icon="shell"]')).toBeVisible(); // the mockup's stroke glyph
    await expect(row(quick).locator('.hr-ag')).toHaveAccessibleName('Shell');
    await expect(row(quick).locator('.hr-st')).toHaveText(/^\d{1,2}:\d{2}( [AP]M)?$/);
    await expect(row(quick).locator('.hr-len')).toHaveText('<1m'); // the mockup's short length, not ticket 1025's "<1 min"
    await expect(row(quick).locator('.hr-sum')).toHaveText(''); // it printed nothing: no line, never its name again
    await expect(row(quick).locator('.hr-pj')).toHaveText('demo');
    // Two lines: the summary sits under the name.
    const [name, sum] = [(await row(quick).locator('.hr-go b').boundingBox())!, (await row(quick).locator('.hr-sum').boundingBox())!];
    expect(sum.y).toBeGreaterThan(name.y + 10);
    // Ended by itself: a hollow rail in the tree's grey, no mark.
    const [mut, bad] = [await token(app, '--tree-mut'), await token(app, '--tree-bad')];
    await expect(row(quick)).toHaveAttribute('data-end', 'done');
    expect(await paint(app, `[data-history="${quick}"] .hr-rail`)).toEqual({ line: mut, fill: HOLLOW });
    await expect(row(quick).locator('.hr-mk')).toHaveCount(0);
    // Failed: a red rail and the tree's x-circle.
    await expect(row(boom)).toHaveAttribute('data-end', 'fail');
    expect(await paint(app, `[data-history="${boom}"] .hr-rail`)).toEqual({ line: bad, fill: bad });
    await expect(row(boom).locator('.hr-mk [data-icon="fail"]')).toBeVisible();
    await expect(row(boom).locator('.hr-mk')).toHaveCSS('color', bad);
    await expect(row(boom).locator('.hr-mk')).toHaveAccessibleName('failed');
    // Stopped: grey, with the stop mark.
    await expect(row(halt)).toHaveAttribute('data-end', 'stop');
    expect(await paint(app, `[data-history="${halt}"] .hr-rail`)).toEqual({ line: mut, fill: HOLLOW });
    await expect(row(halt).locator('.hr-mk [data-icon="stop"]')).toBeVisible();
    await expect(row(halt).locator('.hr-mk')).toHaveCSS('color', mut);
    await expect(row(halt).locator('.hr-mk')).toHaveAccessibleName('Stopped');
    // No row runs past the 320px widget.
    for (const id of [quick, boom, halt]) expect(await row(id).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await row(boom).hover();
    await app.locator('.sbar[data-widget="history"]').screenshot({ path: path.join(SHOTS, `1029-history-side-${scheme}.png`) });
  }
});

test('done_popover_says_stopped (inventory N008, ticket 1025): in the tree\'s finished popover a session you stopped says so beside its time, with History\'s word; one that ended by itself has its time alone', async ({ app, core }) => {
  test.skip(new Date().getHours() === 23 && new Date().getMinutes() >= 48, 'the 11 minutes below would cross midnight: the bars count today only');
  const { quick, halt } = await three(app, core);
  await app.clock.install();
  await openWindow(app);
  await app.clock.fastForward('11:00'); // a session just closed is a fading row for 10 minutes, then it counts in the bars
  await app.locator('.grp[data-project="demo"] > .row.head button.dbar').click();
  const item = (id: string) => app.locator(`[data-done-pop] [data-done-item="${id}"] .tm`);
  await expect(item(halt)).toHaveText(/\S · Stopped$/);
  await expect(item(quick)).toHaveText(/^[^·]+$/);
});

test('history_hover_icons: three icon buttons take the time\'s place on hover, reachable by Tab, named in every language', async ({ app, core, browserName }) => {
  const { quick } = await three(app, core);
  await openWindow(app);
  await openHistory(app);
  const row = app.locator(`[data-history-view] [data-history="${quick}"]`);
  const acts = row.locator('.hr-acts button');
  await expect(acts).toHaveCount(3);
  await app.mouse.move(600, 500);
  await expect(acts.first()).toBeHidden();
  await expect(row.locator('.hr-st')).toBeVisible();
  await row.hover();
  await expect(row.locator('.hr-st')).toBeHidden();
  for (const [i, label] of ACTIONS.entries()) {
    await expect(acts.nth(i)).toBeVisible();
    await expect(acts.nth(i)).toHaveAccessibleName(label);
    await expect(acts.nth(i)).toHaveAttribute('data-tip', label);
    await expect(acts.nth(i)).toHaveText(''); // an icon, no words
    await expect(acts.nth(i).locator('svg')).toHaveCount(1);
  }
  // By keyboard: the name, then the three.
  await app.mouse.move(600, 500);
  await row.locator('.hr-go').focus();
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'; // WebKit's Tab skips buttons, as Safari's does ("Tab to links" off; ticket 531).
  for (const label of ACTIONS) {
    await app.keyboard.press(tab);
    await expect(row.getByRole('button', { name: label })).toBeFocused();
  }
  // The three names are ticket 1022's lines, which every language has (a new line is English only until the languages' pass).
  for (const lang of ['en', 'ko', 'ja', 'zhHans', 'zhHant', 'es', 'fr', 'pt'] as const)
    for (const key of ['history.view', 'history.continue', 'history.changes'] as const) expect((words[lang] as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy();
  // The icon acts as the words did.
  await row.getByRole('button', { name: 'View conversation' }).click();
  await expect(app.locator(`.tab[data-tab="${quick}"]`)).toHaveAttribute('aria-selected', 'true');
});

test('history_wide_tab_rows: as a tab each session is one row, its columns line up, and the run length is a hollow bar', async ({ app, core }) => {
  const { quick, boom, halt } = await three(app, core);
  await openWindow(app);
  await openHistory(app);
  await app.locator('[data-history-view]').getByRole('button', { name: 'Open as a tab' }).click();
  const hist = app.locator('[data-history-view][data-where="tab"]');
  for (const scheme of ['dark', 'light'] as const) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect(hist.locator('[data-history]')).toHaveCount(3);
    const boxes = async (part: string) => Promise.all([quick, boom, halt].map(async (id) => (await hist.locator(`[data-history="${id}"] ${part}`).boundingBox())!));
    // One line: the summary beside the name, not under it.
    const [names, sums, starts, lens] = [await boxes('.hr-go b'), await boxes('.hr-sum'), await boxes('.hr-st'), await boxes('.hr-len')];
    for (const i of [0, 1, 2]) expect(Math.abs(sums[i].y + sums[i].height / 2 - (names[i].y + names[i].height / 2))).toBeLessThan(3);
    for (const col of [names, sums, lens]) expect(new Set(col.map((b) => Math.round(b.x))).size).toBe(1);
    expect(new Set(starts.map((b) => Math.round(b.x + b.width))).size).toBe(1); // the times end on one line
    for (const b of await boxes('')) expect(b.height).toBeLessThanOrEqual(34);
    // The bar: a faint filled bar (ticket 1041, owner 15.1 item 9: finished is one tint step, never an outline), red and
    // filled on a failed row.
    const [faint, bad] = [await token(app, '--tint-2'), await token(app, '--tree-bad')];
    for (const b of await boxes('.hr-dur')) (expect(b.width).toBeGreaterThanOrEqual(5), expect(b.width).toBeLessThanOrEqual(56));
    expect(await paint(app, `[data-history="${quick}"] .hr-dur`)).toEqual({ line: HOLLOW, fill: faint });
    expect(await paint(app, `[data-history="${boom}"] .hr-dur`)).toEqual({ line: bad, fill: bad });
    // The icons keep their column: there on hover, without moving the row's text.
    const act = hist.locator(`[data-history="${quick}"] .hr-acts button`).first();
    await app.mouse.move(5, 5);
    await expect(act).toBeHidden();
    await hist.locator(`[data-history="${quick}"]`).hover();
    await expect(act).toBeVisible();
    await expect(hist.locator(`[data-history="${quick}"] .hr-st`)).toBeVisible();
    expect((await boxes('.hr-sum'))[0]).toEqual(sums[0]);
    await hist.screenshot({ path: path.join(SHOTS, `1029-history-tab-${scheme}.png`) });
  }
});

// The mockup's ten sessions (docs/design/history-1121 `S`): days ago, name, project, branch, agent, start, minutes, how it
// ended, and its line (an agent's last answer; a shell has none in the app: its row carries no command).
const S = [
  [0, 'fix-login', 'nunchiro', 'main', 'claude', '09:42', 18, 'done', 'Fixed the login redirect: sign-in now returns to the page you came from. 12 tests pass.'],
  [0, 'acct-acp-models', 'nunchiro', 'v28-acct-acp-models', 'codex', '09:05', 41, 'done', 'One shared ACP listing for the model chip, and tighter list tests.'],
  [0, 'gate-run', 'nunchiro', 'main', 'shell', '08:51', 6, 'done', 'scripts/check-app.sh'],
  [0, 'tree-fold', 'nunchiro', 'v28-proj-fold', 'claude', '08:15', 72, 'fail', 'Build failed. tsc: 3 type errors in tree/DoneBars.tsx'],
  [0, 'zshrc-clean', 'dotfiles', 'main', 'claude', '07:58', 3, 'done', 'Removed two duplicate PATH lines.'],
  [1, 'bench-1', 'nunchiro', 'main', 'codex', '22:10', 41, 'stop', 'Stopped at step 3 of 5.'],
  [1, 'brew-up', 'dotfiles', 'main', 'shell', '19:03', 2, 'done', 'brew upgrade'],
  [1, 'outbox-undo', 'nunchiro', 'outbox-undo', 'claude', '16:30', 27, 'done', 'Undo now cancels the queued send before it leaves the Outbox.'],
  [2, 'theme-import', 'nunchiro', 'main', 'claude', '14:12', 9, 'done', 'Imported three Ghostty themes.'],
  [2, 'api-retry', 'notes', 'main', 'codex', '11:40', 52, 'fail', 'Lost the connection to the API.'],
] as const;
/** Those ten in the window: real ended shells of this core, each drawn as the mockup's session (its agent, folder, times
 *  and line are set on the way to the window). Every run is quiet after its start (`last_activity`), so a length shown is
 *  the core's end stamp. Gives the ids in the mockup's order. */
async function mockup(app: Page, core: Core, said: (i: number) => string = (i) => S[i][8]) {
  const ids = S.map(([, name, project]) => core.shell(core.project(project), name, '/usr/bin/true').id);
  await expect.poll(() => snap(core).filter((x) => x.state === 'exited').length).toBe(S.length);
  const at = (days: number, hm: string) => {
    const [h, m] = hm.split(':').map(Number);
    const t = new Date();
    t.setDate(t.getDate() - days);
    return t.setHours(h, m, 0, 0);
  };
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const x of msg.sessions ?? []) {
      const i = ids.indexOf(x.id);
      if (i < 0) continue;
      const [days, , , branch, kind, hm, mins, end] = S[i];
      const start = at(days, hm);
      Object.assign(x, { kind, state: end === 'stop' ? 'closed' : 'exited', cwd: branch === 'main' ? x.project : `${x.project}/.wt/${branch}`, start_commit: { kind: 'commit' }, started_at: start, ended_at: start + mins * 60_000 });
      Object.assign(x.attention, { failed: end === 'fail', last_activity: start });
    }
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      const i = ids.indexOf(f?.request?.id);
      const answer = (ok: object) => ws.send(JSON.stringify({ id: f.id, response: { Ok: ok } }));
      if (i >= 0 && S[i][4] !== 'shell' && f.request.op === 'chat_page') return answer({ type: 'chat_page', page: { events: [{ data: { kind: 'final_text', text: said(i) } }] } });
      server.send(m);
    });
    server.onMessage((m) => ws.send(typeof m === 'string' && JSON.parse(m).event === 'snapshot' ? apply(m) : m));
  });
  return ids;
}
const side = (app: Page) => app.locator('.sbar[data-widget="history"]');
const widen = (app: Page) => side(app).evaluate((e) => void ((e as HTMLElement).style.width = '320px'));
/** The mockup's small frame for an empty state (320 by 236): the window made so short that the widget is 236px high, with no
 *  caret in the search field (opening History puts it there). Gives the frame to cut out. */
async function small(app: Page) {
  await app.setViewportSize({ width: 1440, height: 900 - Math.round((await side(app).boundingBox())!.height) + 236 });
  await expect.poll(async () => Math.round((await side(app).boundingBox())!.height)).toBe(236);
  await app.mouse.move(700, 100);
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const box = (await side(app).boundingBox())!;
  return { x: box.x, y: box.y, width: 320, height: 236 };
}

test('history_summary_plain: an agent\'s markdown answer reads as plain words on one line (look v33 S3-1)', async ({ app, core }) => {
  const md = '## **Done:** `touch b.txt` in [the repo](https://example.com/r)\n\n_check_ it';
  const ids = await mockup(app, core, (i) => (i === 0 ? md : S[i][8]));
  await openWindow(app);
  await openHistory(app);
  const sum = app.locator(`[data-history="${ids[0]}"] .hr-sum`);
  await expect(sum).toHaveText('Done: touch b.txt in the repo');
  await expect(sum).toHaveCSS('text-overflow', 'ellipsis');
  await expect(sum).toHaveCSS('white-space', 'nowrap');
});

test('history_row_content: the name and a worktree\'s branch, the start and a short length, then what happened (never the name) and the project', async ({ app, core }) => {
  const ids = await mockup(app, core);
  await openWindow(app);
  await openHistory(app);
  await widen(app);
  const hist = app.locator('[data-history-view]');
  const row = (name: string) => hist.locator(`[data-history="${ids[S.findIndex((x) => x[1] === name)]}"]`);
  await expect(hist.locator('[data-history]')).toHaveCount(10);
  // Line 1: the name; the branch beside it for a worktree only; at the right the start (24-hour) and the short length.
  await expect(row('acct-acp-models').locator('.hr-go b')).toHaveText('acct-acp-models');
  await expect(row('acct-acp-models').locator('.hr-l1 .hr-bn')).toHaveText('v28-acct-acp-models');
  await expect(row('fix-login').locator('.hr-l1 .hr-bn')).toHaveCount(0); // the main folder names no branch in the widget
  await expect(row('fix-login').locator('.hr-st')).toHaveText('09:42');
  await expect(row('bench-1').locator('.hr-st')).toHaveText('22:10');
  // The length is the core's end stamp: each run printed nothing after its start, and none reads "<1m".
  await expect(row('fix-login').locator('.hr-len')).toHaveText('18m');
  await expect(row('tree-fold').locator('.hr-len')).toHaveText('1h 12m');
  await expect(row('brew-up').locator('.hr-len')).toHaveText('2m');
  for (const len of await hist.locator('.hr-len').allTextContents()) expect(len).toMatch(/^(\d+h )?\d+m$/); // no "min", no "<1"
  const [name, time] = [(await row('acct-acp-models').locator('.hr-go b').boundingBox())!, (await row('acct-acp-models').locator('.hr-t').boundingBox())!];
  expect(Math.abs(name.y + name.height / 2 - (time.y + time.height / 2))).toBeLessThan(3); // one line
  expect(time.x + time.width).toBeGreaterThan(320 - 20); // at the right end
  // Line 2: an agent's last answer; a shell (no transcript, no command on its row) has no line; never the name. The
  // project at the right.
  await expect(row('fix-login').locator('.hr-sum')).toHaveText(S[0][8]);
  await expect(row('gate-run').locator('.hr-sum')).toHaveText('');
  for (const [, n] of S) await expect(row(n).locator('.hr-sum')).not.toHaveText(n);
  await expect(row('zshrc-clean').locator('.hr-pj')).toHaveText('dotfiles');
  const [sum, pj] = [(await row('zshrc-clean').locator('.hr-sum').boundingBox())!, (await row('zshrc-clean').locator('.hr-pj').boundingBox())!];
  expect(Math.abs(sum.y + sum.height / 2 - (pj.y + pj.height / 2))).toBeLessThan(3);
  expect(pj.x).toBeGreaterThan(sum.x + sum.width - 1);
  // The mockup's density: a row is 48px, a day's head under 32px, and the text sizes are the mockup's.
  expect((await row('fix-login').boundingBox())!.height).toBe(48);
  expect((await hist.locator('.histv-day').first().boundingBox())!.height).toBeLessThan(32);
  const px = (sel: string) => row('acct-acp-models').locator(sel).evaluate((e) => getComputedStyle(e).fontSize);
  expect([await px('.hr-go b'), await px('.hr-l1 .hr-bn'), await px('.hr-st'), await px('.hr-sum'), await px('.hr-pj')]).toEqual(['13px', '11px', '11px', '12px', '11px']);
  // The day's head: its word, its date, and the count bar at the right.
  const day = hist.locator('.histv-day').first();
  await expect(day).toHaveText(/^Today[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}5$/);
  expect((await day.locator('.dbar').boundingBox())!.x).toBeGreaterThan(320 - 40);
});

test('history_end_stamp: a quiet run\'s length runs to the core\'s own end stamp, not to its last output', async ({ app, core }) => {
  const dir = core.project('demo');
  core.shell(dir, 'keep');
  const still = core.shell(dir, 'still', '/bin/sleep', '2').id;
  type Row = Snap & { started_at: number; ended_at?: number };
  const row = () => (snap(core) as Row[]).find((x) => x.id === still)!;
  expect(row().ended_at).toBeUndefined(); // a run still going has no end
  await expect.poll(() => row().state, { timeout: 15_000 }).toBe('exited');
  // The core stamps the end itself: two seconds after the start, though the run printed nothing.
  expect(row().ended_at! - row().started_at).toBeGreaterThanOrEqual(1900);
  // The window draws the length from that stamp: a run of 18 minutes whose last output was at its start.
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      for (const x of msg.sessions) if (x.id === still) ((x.started_at = x.ended_at - 18 * 60_000), (x.attention.last_activity = x.started_at));
      ws.send(JSON.stringify(msg));
    });
  });
  await openWindow(app);
  await openHistory(app);
  const hist = app.locator('[data-history-view]');
  await expect(hist.locator(`[data-history="${still}"] .hr-len`)).toHaveText('18m');
  await expect(hist.locator(`[data-history="${still}"] .hr-sum`)).toHaveText(''); // a shell named by its label: no line, not its name again
});

test('history_filter_row: the search field, the project list, the agent segment, the stopped-or-failed toggle and the count; no chip row', async ({ app, core }) => {
  const ids = await mockup(app, core);
  await openWindow(app);
  await openHistory(app);
  const hist = app.locator('[data-history-view]');
  const rows = hist.locator('[data-history]');
  const count = hist.locator('.histv-cnt');
  // At the sidebar's default width (250px, narrower than the mockup) the controls still share one line.
  await expect(count).toHaveText('10');
  expect(Math.round((await side(app).boundingBox())!.width)).toBe(250);
  const top = async (l: Locator) => Math.round((await l.boundingBox())!.y);
  expect(await top(hist.getByRole('button', { name: 'Stopped or failed' }))).toBe(await top(hist.locator('.histv-sel')));
  expect(Math.abs((await top(count)) - (await top(hist.locator('.histv-sel'))))).toBeLessThan(8);
  // The list's words are whole there too (the app's WebKit cut a bare select to "A").
  const words = hist.locator('.histv-sel-t');
  await expect(words).toHaveText('All projects');
  const narrow = (await words.boundingBox())!.width;
  await widen(app);
  expect(Math.abs((await words.boundingBox())!.width - narrow)).toBeLessThan(0.5); // as wide as with room to spare: not cut
  await expect(rows).toHaveCount(10);
  await expect(hist.locator('.hf')).toHaveCount(0); // the old chips are gone
  // The search field has the mockup's words and size; the controls sit on one line under it, the count at its right end.
  const q = hist.getByRole('searchbox', { name: 'Search name, branch, conversation' });
  await expect(q).toHaveAttribute('placeholder', 'Search name, branch, conversation');
  expect((await hist.locator('.histv-q').boundingBox())!.height).toBe(28);
  const project = hist.getByRole('combobox', { name: 'Project' });
  const seg = hist.getByRole('group', { name: 'Agent' }).getByRole('button');
  const bad = hist.getByRole('button', { name: 'Stopped or failed' });
  await expect(count).toHaveText('10');
  await expect(count).toHaveAccessibleName('10 sessions');
  const y = async (l: Locator) => Math.round(((await l.boundingBox())!.y + (await l.boundingBox())!.height / 2) / 2);
  expect(new Set([await y(hist.locator('.histv-sel')), await y(seg.first()), await y(bad), await y(count)]).size).toBe(1);
  expect((await count.boundingBox())!.x + (await count.boundingBox())!.width).toBeGreaterThan(320 - 14);
  for (const l of [hist.locator('.histv-sel'), hist.locator('.histv-seg'), bad]) expect((await l.boundingBox())!.height).toBe(24);
  // The project list: every project with a finished session, by name.
  await expect(project.locator('option')).toHaveText(['All projects', 'dotfiles', 'notes', 'nunchiro']);
  await project.selectOption({ label: 'dotfiles' });
  await expect(rows).toHaveCount(2);
  await expect(words).toHaveText('dotfiles'); // the box shows the picked project
  await expect(count).toHaveText('2');
  await project.selectOption({ label: 'All projects' });
  // The agent segment: Claude, Codex and Shell icons, each pressed while its sessions are listed.
  await expect(seg).toHaveCount(3);
  for (const [i, name] of ['Claude', 'Codex', 'Shell'].entries()) {
    await expect(seg.nth(i)).toHaveAccessibleName(name);
    await expect(seg.nth(i)).toHaveAttribute('aria-pressed', 'true');
    await expect(seg.nth(i)).toHaveText(''); // an icon, no words
  }
  await seg.nth(0).click();
  await expect(seg.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(rows).toHaveCount(5); // three Codex, two shells
  await seg.nth(2).click();
  await expect(rows).toHaveCount(3);
  await seg.nth(0).click();
  await seg.nth(2).click();
  await expect(rows).toHaveCount(10);
  // The toggle: an icon; pressed, it is red and only stopped or failed sessions stay.
  await expect(bad).toHaveText('');
  await bad.click();
  await expect(bad).toHaveAttribute('aria-pressed', 'true');
  await expect(bad).toHaveCSS('color', await token(app, '--tree-bad'));
  await expect(rows).toHaveCount(3);
  await expect(hist.locator(`[data-history="${ids[5]}"]`)).toBeVisible(); // bench-1, stopped
  // Nothing matches: the mockup's second empty state, and "Clear filters" puts everything back.
  await project.selectOption({ label: 'dotfiles' });
  await q.fill('oauth');
  await expect(rows).toHaveCount(0);
  await expect(count).toHaveText('0');
  await expect(hist.locator('.histv-empty b')).toHaveText('No sessions match');
  await app.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await app.screenshot({ path: path.join(COMPARE, 'app-nomatch-dark.png'), clip: await small(app) });
  await hist.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(10);
  await expect(q).toHaveValue('');
  await expect(project).toHaveValue('');
  await expect(bad).toHaveAttribute('aria-pressed', 'false');
});

test('history_empty_state: before the first session ends, three hollow bars and two lines; no count', async ({ app }) => {
  await openWindow(app);
  await openHistory(app);
  await widen(app);
  await app.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const hist = app.locator('[data-history-view]');
  await expect(hist.locator('.histv-empty b')).toHaveText('No finished sessions yet');
  await expect(hist.locator('.histv-empty small')).toHaveText('Sessions land here when they end.');
  await expect(hist.locator('.histv-empty .dbar i')).toHaveCount(3);
  await expect(hist.locator('.histv-cnt')).toHaveCount(0);
  await expect(hist.getByRole('searchbox')).toBeVisible(); // the filters stay
  await app.screenshot({ path: path.join(COMPARE, 'app-empty-light.png'), clip: await small(app) });
});

test.describe('beside the mockup', () => {
  test('mockup_side_by_side: the mockup\'s ten sessions at its sizes (320px widget, 1000px tab), light and dark, plain and hovered', async ({ app, core }) => {
    const ids = await mockup(app, core);
    await openWindow(app);
    await openHistory(app);
    await widen(app);
    const hist = app.locator('[data-history-view]');
    await expect(hist.locator('[data-history]')).toHaveCount(10);
    // Ticket 1041: the mockup's order, by the start each row shows (tree-fold 08:15 after gate-run 08:51, though it ended later).
    expect(await hist.locator('[data-history]').evaluateAll((els) => els.map((e) => e.getAttribute('data-history')))).toEqual(ids);
    await expect(hist.locator(`[data-history="${ids[9]}"] .hr-sum`)).toHaveText(S[9][8]);
    // The mockup hovers the first row (light) and the failed one (dark), with Continue's tip up.
    const shoot = async (where: 'widget' | 'tab', scheme: 'light' | 'dark', hover: number, of: Locator, w: number, h: number) => {
      await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const box = (await of.boundingBox())!;
      const clip = { x: box.x, y: box.y, width: w, height: h };
      await app.mouse.move(box.x + w / 2, box.y + h + 200);
      await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // opening History puts the caret in its search field
      await expect(app.locator('.apptip')).toBeHidden();
      await app.screenshot({ path: path.join(COMPARE, `app-${where}-${scheme}.png`), clip });
      const row = hist.locator(`[data-history="${ids[hover]}"]`);
      await row.hover();
      await row.getByRole('button', { name: 'Continue' }).hover();
      await expect(app.locator('.apptip')).toHaveText('Continue');
      await app.screenshot({ path: path.join(COMPARE, `app-${where}-${scheme}-hover.png`), clip });
    };
    await shoot('widget', 'light', 0, side(app), 320, 600);
    await shoot('widget', 'dark', 3, side(app), 320, 600);
    await app.mouse.move(700, 500);
    await hist.getByRole('button', { name: 'Open as a tab' }).click();
    const tab = app.locator('[data-history-view][data-where="tab"]');
    await expect(tab).toBeVisible();
    await app.setViewportSize({ width: 1440 - Math.round((await tab.boundingBox())!.width) + 1000, height: 900 });
    await expect.poll(async () => Math.round((await tab.boundingBox())!.width)).toBe(1000);
    await shoot('tab', 'light', 1, tab, 1000, 460);
    await shoot('tab', 'dark', 3, tab, 1000, 460);
  });
});
