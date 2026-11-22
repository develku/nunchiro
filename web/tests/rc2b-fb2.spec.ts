// V2.5-41 / V2.5-68 rc2b-fb2 (needs 190 (2)): web follow-ups from the installed RC2b, one named test per item.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test as plain, type Page } from '@playwright/test';
import { LayoutStore } from '../src/layout/store';
import { leaves, type Layout } from '../src/layout/model';
import { ko } from '../src/i18n/areas/shell';
import { ko as koExit } from '../src/i18n/areas/exit-widgets';
import { ko as koLayout } from '../src/i18n/areas/rest-layout';
import { EN } from './i18n-tables';
import { sidebar } from './d5b';
import { agentsZone, expect, openWindow, test, type Core } from './fixtures';
import { openQuiet } from './tree-seed';

const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
/** A shell session in its own worktree; its row is named after that worktree. */
const wtSession = (core: Core, project: string, label: string) =>
  core.cli('session', 'start', '--kind', 'shell', '--project', project, '--label', label, '--worktree', '--', '/bin/cat').session as { id: string; cwd: string };

type Edit = (s: { id: string; label: string; project: string; state: string; attention: Record<string, unknown>; pending: unknown[] }) => void;
/** The core cannot make a session stale, ended-but-stale or hold a stale-only queue on demand: the window's socket is
 *  proxied and each session (by label) is edited in every snapshot, as tree-rows.spec.ts does for its states. */
async function patchSnapshots(app: Page) {
  const edits = new Map<string, Edit>();
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) edits.get(s.label)?.(s);
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m === 'string' && JSON.parse(m).event === 'snapshot') ws.send(apply((last = m)));
      else ws.send(m);
    });
  });
  return {
    set(label: string, e: Edit) {
      edits.set(label, e);
      if (last) for (const ws of sockets) ws.send(apply(last));
    },
  };
}
const ago = (ms: number) => Date.now() - ms;
const staleFlag: Edit = (s) => Object.assign(s.attention, { working: false, waiting: false, failed: false, stale: true, last_activity: ago(10 * 60_000) });
const staleItem = (s: Parameters<Edit>[0]) => ({ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: 'stale', text: 'No output for 10 min', choices: [], observed_at: ago(600_000), actionable: false });

const rowOf = (app: Page, id: string) => app.locator(`.row.wt2[data-menu-session="${id}"]`);
const dot = (app: Page, id: string) => app.locator(`.ar[data-agent="${id}"] .st`);

test('tree_and_agents_agree_on_state: a session that is not running reads done in the tree row and the Agents list; a running stale one reads stale in both', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  const ended = wtSession(core, p, 'ended');
  const silent = wtSession(core, p, 'silent');
  openQuiet(core);
  agentsZone(core);
  const patch = await patchSnapshots(app);
  await openWindow(app);
  // The ended session still carries the stale flag, and its queue item, from before it stopped.
  patch.set('ended', (s) => (staleFlag(s), (s.state = 'exited'), (s.pending = [staleItem(s)])));
  patch.set('silent', staleFlag);
  await expect(dot(app, ended.id)).toHaveAttribute('data-s', 'done');
  await expect(dot(app, silent.id)).toHaveAttribute('data-s', 'stale');
  await expect(rowOf(app, ended.id)).toHaveAttribute('data-kind', 'idle');
  await expect(app.locator(`.q[data-line="${ended.id}"]`)).toHaveCount(0); // no stale line under a row that reads done
  await expect(rowOf(app, ended.id).locator('.tip b')).toHaveText('done · Shell');
  await expect(rowOf(app, silent.id)).toHaveAttribute('data-kind', 'stale');
  await expect(rowOf(app, silent.id).locator('.tip b')).toContainText('stale · no output for');
});

const setLanguage = (app: Page, language: string) =>
  app.evaluate((l) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'), language: l })), language);

test('agents_header_counts_running: the Agents header says how many of the listed sessions run, from a catalogue key, in English and Korean', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'a');
  core.shell(p, 'b');
  const gone = core.shell(p, 'c').id;
  core.windowClose(gone); // ticket 1013 F6: the window's own Close keeps the done tab
  agentsZone(core);
  await openWindow(app);
  const count = app.locator('section.agents .ph .r');
  await expect(count).toContainText('2 of 3 running');
  await expect(count).not.toContainText('running first');
  await setLanguage(app, 'ko');
  await app.reload();
  await expect(count).toContainText('3개 중 2개 실행 중');
});

test('stale_only_row_does_not_open_decisions: a row whose only item is a stale flag opens its session; a row with a real ask still jumps to Decisions', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  const quiet = wtSession(core, p, 'quiet');
  const asks = wtSession(core, p, 'asks');
  const other = wtSession(core, p, 'other');
  openQuiet(core);
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('quiet', (s) => (staleFlag(s), (s.pending = [staleItem(s)])));
  patch.set('asks', (s) =>
    Object.assign(s.attention, { waiting: true, last_activity: ago(1000) }) && (s.pending = [{ id: 'd-asks', session_id: s.id, scope: s.project, kind: 'permission', text: 'Run asks?', choices: [], observed_at: ago(60_000), actionable: true }]),
  );
  const decisions = sidebar(app, 'right');
  const tab = (id: string) => app.locator(`.tab[data-tab="${id}"]`);
  await app.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(tab(other.id)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator(`.q[data-line="${quiet.id}"]`)).toBeVisible();
  // Enter, the row's way to the card since a click opens any row's session: a stale flag has no card to jump to.
  await rowOf(app, quiet.id).focus();
  await app.keyboard.press('Enter');
  await expect(tab(quiet.id)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('aside.sbar[data-widget="decisions"]')).toHaveCount(0);
  // A real ask still jumps to the widget, by Enter on its row (look 1117 v3 item 10, ffa0a3172: a click on any row opens
  // its session; the line's details, Enter and 2 jump to the card).
  await rowOf(app, asks.id).focus();
  await app.keyboard.press('Enter');
  await expect(decisions).toHaveAttribute('data-widget', 'decisions');
});

test('notice_toast_times_out: the copy-on-select toast leaves after 10 s, waits while hovered or focused, and Undo inside the window restores the old value', async ({ app }) => {
  const stored = () => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').copyOnSelect);
  const toast = app.locator('.toast').filter({ has: app.getByRole('button', { name: 'Undo' }) });
  await app.clock.install();
  // A store from before version 2 that turned copy on select off: the start-up migration moves it and offers Undo.
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ copyOnSelect: false })));
  await openWindow(app);
  await expect(toast).toBeVisible();
  expect(await stored()).toBe(true);
  await app.clock.runFor(9_000);
  await expect(toast).toBeVisible();
  await app.clock.runFor(1_500);
  await expect(toast).toHaveCount(0);
  // Hovered, the clock stops; the full 10 s count again once the pointer leaves.
  await app.reload();
  await expect(toast).toBeVisible();
  await toast.hover();
  await app.clock.runFor(30_000);
  await expect(toast).toBeVisible();
  await app.mouse.move(700, 600);
  await app.clock.runFor(9_000);
  await expect(toast).toBeVisible();
  await app.clock.runFor(1_500);
  await expect(toast).toHaveCount(0);
  // Focused (keyboard), the same.
  await app.reload();
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).focus();
  await app.clock.runFor(30_000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Undo' }).blur();
  await app.clock.runFor(10_500);
  await expect(toast).toHaveCount(0);
  // Undo, before the window ends, puts the old value back.
  await app.reload();
  await expect(toast).toBeVisible();
  await app.clock.runFor(5_000);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0);
  await expect.poll(stored).toBe(false);
});

test('f2_after_mouse_click_renames_row: after a mouse click on a worktree row or a main-folder session row, F2 renames that row, not the tab', async ({ app, core }) => {
  const p = gitRepo(core, 'repo');
  core.cli('worktree', 'create', '--project', p, '--branch', 'named', '--no-focus');
  const main = core.shell(p, 'main-shell');
  const patch = await patchSnapshots(app);
  // WKWebView (the app) does not focus a button on a mouse click; Playwright's engines do. A cancelled mousedown on a
  // button leaves focus where it was in any engine, which is what the app's webview does.
  await app.addInitScript(() => document.addEventListener('mousedown', (e) => (e.target as Element).closest?.('button') && e.preventDefault(), true));
  await openWindow(app);
  patch.set('main-shell', (s) => Object.assign(s.attention, { working: true, last_activity: ago(1000) }));
  const tabInput = app.locator('.tab input');
  // A worktree row (no session yet): a click selects it.
  const wt = app.locator('.row.wt2').filter({ hasText: 'named' }).first();
  await wt.click({ position: { x: 6, y: 6 } });
  await app.keyboard.press('F2');
  await expect(app.getByRole('textbox', { name: /Worktree label/ })).toBeVisible();
  await expect(tabInput).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('textbox', { name: /Worktree label/ })).toHaveCount(0);
  // A main-folder session's own row (a working session): the same.
  const mainRow = rowOf(app, main.id);
  await expect(mainRow).toHaveAttribute('data-menu', 'treerow');
  await mainRow.click({ position: { x: 6, y: 6 } });
  await app.keyboard.press('F2');
  await expect(app.getByRole('textbox', { name: /Session name/ })).toBeVisible();
  await expect(tabInput).toHaveCount(0);
});

const KO_CENTRE = '중앙 채팅은 창에 남아 있어야 합니다: 다른 위젯은 그 옆에 놓으세요';
test('layout_strings_translated: in Korean the zone label, the centre-chat refusal and the four Terminal and Browser icon toasts are Korean', async ({ app, core }) => {
  const project = core.project('demo');
  await app.addInitScript(() => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ language: 'ko' })));
  const icon = (name: string) => app.locator('.ib.r').getByRole('button', { name, exact: true });
  const toast = app.locator('.toast[role="status"] > span').first();
  await app.goto('/'); // openWindow waits for the English "Connected" line
  await expect(icon(ko['shell.widget.terminal'])).toBeVisible();
  // No session open.
  // v25f F14 (amends ticket 288): no session and no folder starts a shell in $HOME; no dialog, no refusal toast.
  await icon(ko['shell.widget.terminal']).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(1);
  await expect(app.getByRole('dialog')).toHaveCount(0);
  await expect(toast).toHaveCount(0);
  // That shell is now current: its terminal is the centre; it has no agent browser.
  await icon(ko['shell.widget.terminal']).click();
  await expect(toast).toHaveText('이 세션은 터미널을 중앙에 보여 줍니다');
  await icon(ko['shell.widget.browser']).click(); // ticket 288: no refusal; the user's own browser, with its space switcher
  await expect(app.locator('aside.sbar[data-side="right"]').getByLabel(koExit['exitWidgets.spaces'])).toHaveValue('you');
  // An agent that has ended.
  // Ticket 570: the strip shows the selected project's tabs, and the new shell is in the core's $HOME project.
  const alpha = core.agent(fs.realpathSync(path.join(core.home, 'sentinel-home')), 'alpha', path.join(project, 'never'));
  await expect(app.locator('.tab[data-tab]')).toHaveCount(2);
  await app.locator('.tab[data-tab]', { hasText: 'alpha' }).click();
  await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).not.toHaveAttribute('data-s', 'done'); // running: the wait below is not vacuous
  core.windowClose(alpha.id); // ticket 1013 F6: the window's own Close keeps the done tab
  await expect(app.locator('.tab[data-tab]', { hasText: 'alpha' })).toHaveCount(1);
  // As in rc2b-fb.spec right_bar_icon_never_silent (v25-rc2c-testfix): the tab's dot reads done once the window
  // knows the session ended, the state the icon click reads (useRails iconClick); wait for that signal, not a race.
  await expect(app.locator('.tabw', { hasText: 'alpha' }).locator('.tdot')).toHaveAttribute('data-s', 'done');
  // Real-app 11-10 defect M (ticket 434): the click never restarts the ended agent; its tab stays. Ticket 1037: it opens a
  // new shell instead (as rc2b-fb.spec right_bar_icon_never_silent in English).
  await icon(ko['shell.widget.terminal']).click();
  await expect(app.locator('.tab[data-tab]')).toHaveCount(3);
  expect((core.cli('snapshot', '--json').sessions as { kind: string; label: string; state: string }[]).filter((x) => x.kind === 'claude' && x.label === 'alpha' && x.state === 'running')).toHaveLength(0);
  await expect(app.locator('.tab[data-tab]', { hasText: 'alpha' })).toHaveCount(1);
  // Layout edit: the chat zone's label, and the refusal to remove it.
  await icon(ko['shell.widget.layout']).click();
  await expect(app.locator('[data-zone-id="terminal"] .zl b')).toHaveText('채팅');
  // Ticket 511: the Remove button's name comes from the catalogue since lane 508; the zone is its visible label.
  await app.getByRole('button', { name: new RegExp(`^${koLayout['rest.layout.removeFrom'].replace('{zone}', ko['shell.zone.chat']).replace('{name}', '.*')}$`) }).click();
  await expect(app.locator('.emsg[data-error="true"]')).toHaveText(KO_CENTRE);
});

plain('unpinned_centre_removable_with_pinned: with a pinned and an unpinned terminal zone, removing the unpinned one is allowed; removing the last terminal is refused and changes nothing', async () => {
  const layout: Layout = {
    version: 1,
    root: {
      id: 'main',
      split: 'column',
      children: [
        { id: 'terminal', widgets: ['terminal'] },
        { id: 'pinned', widgets: ['terminal@s1'] },
        { id: 'composer', widgets: ['composer'] },
      ],
    },
  };
  const m = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }, configurable: true });
  try {
    const store = new LayoutStore(async () => {}, (key) => EN[key]);
    store.fromFile({ layout, error: null });
    await store.run({ op: 'remove', zone: 'terminal' }); // the unpinned zone goes: a pinned terminal remains
    expect(leaves(store.current.root).map((z) => z.id)).toEqual(['pinned', 'composer']);
    const before = structuredClone(store.current);
    await expect(store.run({ op: 'remove', zone: 'pinned' })).rejects.toThrow('The centre chat stays in the window: place other widgets beside it');
    expect(store.current).toEqual(before);
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
