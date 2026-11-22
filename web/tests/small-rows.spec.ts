// Ticket 270 (needs 197; G30, G31, G34): alerts per machine, most-recent tab cycling, agent credits left out of a merge.
// The app shell is stood in for by a recording `__TAURI_INTERNALS__` (`notify` is the OS notification, `play_sound` a cue);
// a session's machine is set on the snapshot frames the window gets; the PR view runs the real core against a `gh` shim.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, type Core } from './fixtures';
import { append, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { closeSettings } from './settings-modal';

type Call = { cmd: string; args: { session?: string; name?: string } };
const nav = (app: Page) => app.locator('.settings > nav');
const openSettings = async (app: Page) => {
  await app.getByRole('navigation', { name: 'Left bar' }).getByRole('button', { name: 'Settings' }).click();
  await expect(nav(app)).toBeVisible();
};
const page = (app: Page, id: string) => nav(app).locator(`button[data-page="${id}"]`);
/** Seeds the window store once (a reload keeps what the window saved since). */
const seed = (app: Page, s: Record<string, unknown>) =>
  app.addInitScript((s) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('nunchiro.settings.v1', JSON.stringify(s));
      sessionStorage.setItem('seeded', '1');
    }
  }, s);
const stored = (app: Page) => app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}').features);
const calls = (app: Page, cmd: string) => app.evaluate((c) => (window as unknown as { __calls: Call[] }).__calls.filter((x) => x.cmd === c), cmd);

/** Records shell calls; `machines` puts a session on a machine in every snapshot frame; `details` answers `machine_details`;
 *  `working` overrides `attention.working` and `push` resends the last frame with it (notify-turn-end.spec.ts's way). */
async function stub(app: Page, machines: Record<string, string>, details?: { machine: string }[]) {
  const d: { working: Record<string, boolean>; last: string | null; push: () => void } = { working: {}, last: null, push: () => {} };
  const sockets: { send(m: string): void }[] = [];
  const patch = (raw: string) => {
    const msg = JSON.parse(raw) as { sessions: { id: string; machine?: string; attention: { working: boolean } }[] };
    for (const s of msg.sessions) {
      if (machines[s.id]) s.machine = machines[s.id];
      if (s.id in d.working) s.attention.working = d.working[s.id];
    }
    return JSON.stringify(msg);
  };
  d.push = () => void (d.last && sockets.forEach((ws) => ws.send(patch(d.last!))));
  await app.addInitScript(() => {
    const w = window as unknown as { __calls: Call[]; __TAURI_INTERNALS__: unknown };
    w.__calls = [];
    w.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: Call['args']) => (w.__calls.push({ cmd, args }), Promise.resolve(null)), transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };
  });
  await app.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (details && msg.request?.op === 'machine_details') ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'machine_details', machines: details } } }));
      else server.send(raw);
    });
    server.onMessage((raw) => {
      const msg = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (msg?.event !== 'snapshot') return ws.send(raw);
      d.last = raw as string;
      ws.send(patch(d.last));
    });
  });
  return d;
}
/** One working turn on `id`: working, then not, each pushed as a snapshot and seen on the tab's dot before going on. */
async function turn(app: Page, d: Awaited<ReturnType<typeof stub>>, id: string) {
  const dot = app.locator(`.tab[data-tab="${id}"] .tdot`);
  d.working[id] = true;
  d.push();
  await expect(dot).toHaveAttribute('data-s', 'working');
  d.working[id] = false;
  d.push();
  await expect(dot).toHaveAttribute('data-s', 'idle');
}
const asker = (core: Core, p: string, label: string, go: string) => ({ ...core.agent(p, label, go), go });
const arrive = (a: { cwd: string; go: string }) => fs.writeFileSync(path.join(a.cwd, a.go), '');
const pending = (core: Core) => core.cli('snapshot', '--json').sessions.flatMap((s: { pending: { id: string }[] }) => s.pending.map((d) => d.id)) as string[];
const WAITING_SOUND = 'Ping'; // settings.ts DEFAULTS.soundWaiting
const DONE_SOUND = 'Glass'; // settings.ts DEFAULTS.soundDone
const sounds = async (app: Page, name: string) => (await calls(app, 'play_sound')).filter((c) => c.args.name === name).length;

test('alerts_machine_off_skips_notification_and_sound_keeps_queue', async ({ app, core }) => {
  await app.addInitScript(() => (document.hasFocus = () => false));
  const p = core.project('demo');
  const off = asker(core, p, 'remote-asks', 'go-a');
  const on = asker(core, p, 'local-asks', 'go-b');
  // Turn ends run on two shells: a session with an item waiting has no turn end (queue/turns.ts).
  const offTurn = core.shell(p, 'remote-turn').id;
  const onTurn = core.shell(p, 'local-turn').id;
  const d = await stub(app, { [off.id]: 'buildbox', [offTurn]: 'buildbox' });
  await seed(app, { features: { 'alerts.machines': { buildbox: false } } });
  await openWindow(app, {}, core);
  arrive(off);
  // The queue is untouched: the item waits in the core and the tab shows it waiting.
  await expect.poll(() => pending(core).length).toBe(1);
  await expect(app.locator(`.tab[data-tab="${off.id}"] .tdot[data-s="waiting"]`)).toBeVisible();
  // The same item on this Mac (on), arriving after, notifies and cues: the barrier for the negatives below.
  arrive(on);
  await expect.poll(async () => (await calls(app, 'notify')).map((c) => c.args.session)).toContain(on.id);
  await expect.poll(() => sounds(app, WAITING_SOUND)).toBe(1);
  expect((await calls(app, 'notify')).map((c) => c.args.session)).not.toContain(off.id);
  expect(await sounds(app, WAITING_SOUND)).toBe(1); // on's only
  expect(pending(core).length).toBe(2);
  // Turn ends, neither viewed: the switched-off machine's first, then this Mac's; once this Mac's has rung, the first
  // has had its chance and rang nothing (useCoreLink's done cue and turn-end notification).
  await app.locator(`.tab[data-tab="${on.id}"]`).click();
  const done = await sounds(app, DONE_SOUND);
  await turn(app, d, offTurn);
  await turn(app, d, onTurn);
  await expect.poll(async () => (await calls(app, 'notify')).map((c) => c.args.session)).toContain(onTurn);
  await expect.poll(() => sounds(app, DONE_SOUND)).toBe(done + 1);
  expect((await calls(app, 'notify')).map((c) => c.args.session)).not.toContain(offTurn);
});

test('alerts_machine_rows_list_this_mac_and_ssh_machines', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await stub(app, {}, [{ machine: 'buildbox' }, { machine: 'studio' }]);
  await openWindow(app, {}, core);
  await openSettings(app);
  await page(app, 'alerts').click();
  const sec = app.getByRole('region', { name: 'Machines' });
  const sw = (name: string) => sec.getByRole('switch', { name: `Alerts from ${name}` });
  for (const name of ['This Mac', 'buildbox', 'studio']) await expect(sw(name)).toBeChecked(); // all on by default
  await sw('buildbox').press('Space'); // keyboard path
  await expect(sw('buildbox')).not.toBeChecked();
  await expect.poll(() => stored(app)).toEqual({ 'alerts.machines': { buildbox: false } });
  await sw('This Mac').click();
  await expect.poll(() => stored(app)).toEqual({ 'alerts.machines': { buildbox: false, '': false } });
  await sw('buildbox').click();
  await expect.poll(() => stored(app)).toEqual({ 'alerts.machines': { buildbox: true, '': false } });
});

/** Three shell tabs, focused one, two, three by click: last focus newest first is three, two, one. */
async function threeFocused(app: Page, core: Core) {
  const p = core.project('demo');
  const ids = ['one', 'two', 'three'].map((l) => core.shell(p, l).id);
  await openWindow(app, {}, core);
  for (const id of ids) {
    await app.locator(`.tab[data-tab="${id}"]`).click();
    await expect(app.locator(`.tab[data-tab="${id}"]`)).toHaveAttribute('aria-selected', 'true');
  }
  return ids;
}
const activeTab = (app: Page) => app.locator('.tab[aria-selected="true"]');
const NEXT = 'Shift+Meta+BracketRight';
const PREV = 'Shift+Meta+BracketLeft';
/** With ⌘ held (`keyboard.down('Meta')`), the same keys without it. */
const HELD_NEXT = 'Shift+BracketRight';
const HELD_PREV = 'Shift+BracketLeft';

test('tab_cycle_mru_walks_last_focused_first', async ({ app, core }) => {
  await seed(app, { features: { 'tabs.cycle_order': 'mru' } });
  const [a, b, c] = await threeFocused(app, core);
  // Presses with ⌘ held walk one frozen list: two (focused before three), then one, then back to two.
  await app.keyboard.down('Meta');
  await app.keyboard.press(HELD_NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', b);
  await app.keyboard.press(HELD_NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', a);
  await app.keyboard.press(HELD_PREV);
  await expect(activeTab(app)).toHaveAttribute('data-tab', b);
  // Releasing ⌘ ends the walk on two: two is newest, so the next press goes back to three, and the one after to two.
  await app.keyboard.up('Meta');
  await app.keyboard.press(NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', c);
  await app.keyboard.press(NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', b);
  // A click is a focus too: one is now newest, then two, then three.
  await app.locator(`.tab[data-tab="${a}"]`).click();
  await app.keyboard.down('Meta');
  await app.keyboard.press(HELD_NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', b);
  await app.keyboard.press(HELD_NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', c);
  await app.keyboard.up('Meta');
});

test('tab_cycle_mru_walk_ends_after_idle_with_the_prefix_form', async ({ app, core }) => {
  await seed(app, { features: { 'tabs.cycle_order': 'mru' } });
  const [a, b, c] = await threeFocused(app, core);
  const press = async (want: string) => {
    await app.keyboard.press('Control+Period');
    await app.keyboard.press('KeyN');
    await expect(activeTab(app)).toHaveAttribute('data-tab', want);
  };
  // Quick presses walk one list, as with ⌘ held.
  await press(b);
  await press(a);
  // No ⌘ to release: after a pause the walk is over, one is newest, and the next press starts from the new order.
  await app.waitForTimeout(1700);
  await press(c);
});

test('tab_cycle_strip_order_unchanged_by_default', async ({ app, core }) => {
  const [a, b, c] = await threeFocused(app, core);
  await app.keyboard.press(NEXT); // three wraps to one
  await expect(activeTab(app)).toHaveAttribute('data-tab', a);
  await app.keyboard.press(NEXT);
  await expect(activeTab(app)).toHaveAttribute('data-tab', b);
  await app.keyboard.press(PREV);
  await app.keyboard.press(PREV);
  await expect(activeTab(app)).toHaveAttribute('data-tab', c);
});

test('small_rows_on_their_pages_and_searchable', async ({ app, core }) => {
  core.shell(core.project('demo'), 'alpha');
  await openWindow(app, {}, core);
  await openSettings(app);
  const search = nav(app).getByRole('searchbox', { name: 'Search settings' });
  for (const [label, pageId, at] of [
    ['Alerts per machine', 'alerts', '[data-setting="alertMachines"]'],
    ['Next/previous session order', 'keys', '[data-setting="tabCycleOrder"]:checked'],
    ['Remove agent credits when merging', 'git', '[data-setting="stripAgentCredits"]'],
  ] as const) {
    await page(app, 'general').click();
    await search.fill(label);
    await app.getByRole('list', { name: 'Matching settings' }).getByRole('button', { name: new RegExp(`^${label} · `) }).click();
    await expect(page(app, pageId)).toHaveAttribute('aria-current', 'page');
    await expect(app.locator(at).first()).toBeFocused();
  }
  // The controls are wired: the order is stored per window, the credits switch in the core.
  await page(app, 'keys').click();
  await app.getByRole('radiogroup', { name: 'Next/previous session order' }).getByRole('radio', { name: 'Most recently used' }).check();
  await expect.poll(() => stored(app)).toEqual({ 'tabs.cycle_order': 'mru' });
  await page(app, 'git').click();
  const credits = app.getByRole('switch', { name: 'Remove agent credits when merging' });
  await expect(credits).not.toBeChecked(); // off by default
  await credits.click();
  await expect(credits).toBeChecked();
  // The switch shows the change at once (ticket 993: a core value shows as set until the core answers); the file follows.
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(core.home, 'settings.json'), 'utf8')).features?.['pr.strip_agent_credits']).toBe(true);
  // Palette entries too.
  await app.keyboard.press('Meta+KeyK');
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  for (const id of ['settings.alerts.alertMachines', 'settings.keys.tabCycleOrder', 'settings.git.stripAgentCredits']) await expect(palette.locator(`[data-command="${id}"]`)).toHaveCount(1);
});

// G34 end to end through the PR view (pr-view.spec.ts's shim, plus GitHub's squash text the core asks for when the setting is on).
const URL = 'https://github.com/develku/nunchiro/pull/12';
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const VIEW = {
  number: 12, title: 'Add the PR view', url: URL, state: 'OPEN', isDraft: false, author: 'develku', body: '', createdAt: '2026-10-30T10:00:00Z',
  headRefOid: HEAD, headRefName: 'lane', baseRefName: 'main', reviewDecision: '', mergeable: 'MERGEABLE', additions: 1, deletions: 0, labels: [],
  requested: [], latest: [], checks: [], commits: [{ at: '2026-10-30T10:01:00Z', who: 'develku', text: 'first commit' }], comments: [], reviews: [], files: [],
};
const SQUASH_TEXT = '* first commit\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Kim <kim@example.com>\n\n* --admin second\n\nCo-authored-by: Codex <codex@openai.com>';
function shim(home: string) {
  fs.writeFileSync(path.join(home, 'gh-view'), JSON.stringify(VIEW));
  fs.writeFileSync(path.join(home, 'gh-squash'), JSON.stringify({ data: { repository: { pullRequest: { viewerMergeBodyText: SQUASH_TEXT } } } }));
  // One argv per record, NUL-separated, so a multi-line --body= value stays one field.
  fs.writeFileSync(
    path.join(home, 'bin/gh'),
    `#!/bin/sh\nprintf '%s\\0' "$@" >> '${home}/gh-runs'\nprintf '\\036' >> '${home}/gh-runs'\ncase "$2" in\n  graphql) /bin/cat '${home}/gh-squash' ;;\n  view) /bin/cat '${home}/gh-view' ;;\n  diff) printf '+added line\\n' ;;\nesac\n`,
    { mode: 0o700 },
  );
  return () => (fs.existsSync(path.join(home, 'gh-runs')) ? fs.readFileSync(path.join(home, 'gh-runs'), 'utf8').split('\x1e').filter(Boolean).map((r) => r.split('\0').slice(0, -1)) : []);
}

chatTest('merge_strip_credits_rebase_note_shown', async ({ page: app, chatCore }) => {
  const runs = shim(chatCore.home);
  const s = chatCore.chat('alpha');
  append(s.file, rec.user('open a pr'), rec.use('t1', 'Bash', { command: 'gh pr create' }), rec.result('t1', URL));
  await openChat(app, s.id);
  const chip = app.locator('.shead .prchip button').first();
  await expect(chip).toBeVisible({ timeout: 20_000 });
  const dlg = app.getByRole('dialog', { name: 'Pull request' });
  // Off (the default): no note.
  await chip.click();
  await dlg.getByRole('button', { name: 'Turn on' }).click();
  await expect(dlg.getByRole('combobox', { name: 'Merge method' })).toBeVisible();
  await expect(dlg.getByText('Only a squash merge leaves out agent credits')).toHaveCount(0);
  await app.keyboard.press('Escape');
  // On through Settings > Git (two clicks from the left bar's Settings).
  await openSettings(app);
  await page(app, 'git').click();
  await app.getByRole('switch', { name: 'Remove agent credits when merging' }).click();
  await expect(app.getByRole('switch', { name: 'Remove agent credits when merging' })).toBeChecked();
  await closeSettings(app); // the status chip sits behind the Settings modal
  await chip.click();
  await expect(dlg.getByText('Only a squash merge leaves out agent credits. Merge and rebase keep the commits as they are.')).toBeVisible();
  // A squash merge still asks first, and carries the body without the agent lines; Kim stays.
  await dlg.getByRole('combobox', { name: 'Merge method' }).selectOption('squash');
  await dlg.getByRole('button', { name: 'Merge…' }).click();
  await dlg.getByRole('button', { name: 'Merge now' }).click();
  await expect.poll(() => runs().filter((r) => r[1] === 'merge')).toEqual([
    ['pr', 'merge', URL, '--squash', '--match-head-commit', HEAD, '--body=* first commit\n\nCo-Authored-By: Kim <kim@example.com>\n\n* --admin second'],
  ]);
});
