// Ticket 180 (finding 34 and 16): approved decisions the real app missed. One test per acceptance item of the brief:
// needs 102 page colour, needs 92 working row and head counts, needs 107 no bar above the composer, needs 109 one Diff.
import type { Page } from '@playwright/test';
import { expect, openWindow, showComposer, test, type Core } from './fixtures';
import { fakes, gitRepo, PERMISSION, proxy, show } from './decision-rows-seed';
const DIFF_OPEN = 'nunchiro:diff.open'; // diff/Diff.tsx (it imports CSS, which the runner cannot load)

// ---- the core cannot hold a session "working" or broken on demand, so the window's socket is proxied and each
// session's attention is patched by label (as in tree-rows.spec.ts; the tree is a pure view of the snapshot).
type Patch = { working?: boolean; failed?: boolean; waiting?: boolean };
async function patchSnapshots(app: Page) {
  const patches = new Map<string, Patch>();
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) {
      const p = patches.get(s.label);
      if (!p) continue;
      Object.assign(s.attention, { working: !!p.working, stale: false, failed: !!p.failed, waiting: !!p.waiting, last_activity: Date.now() - 600_000 });
      if (p.waiting)
        s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: 'permission', text: `Run ${s.label}?`, choices: [], observed_at: Date.now() - 60_000, actionable: true }];
    }
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
    set(label: string, p: Patch) {
      patches.set(label, p);
      if (last) for (const ws of sockets) ws.send(apply(last));
    },
  };
}

const bg = (app: Page, sel: string) => app.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);
const RGB = { '#f6f6f4': 'rgb(246, 246, 244)', '#ffffff': 'rgb(255, 255, 255)', '#0d1117': 'rgb(13, 17, 23)', '#151b23': 'rgb(21, 27, 35)' };
const SETTINGS = 'nunchiro.settings.v1';

async function expectPage(app: Page, page: string, panel: string) {
  for (const sel of ['nav.ib.l', 'nav.ib.r']) expect(await bg(app, sel), `${sel} is page`).toBe(page);
  expect(await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--page').trim())).toBe(Object.entries(RGB).find(([, v]) => v === page)![0]);
  // Ticket 1041 (mockup polish-1121): the tree sidebar sits on the page tint with its icon bar; the tab strip is a panel.
  expect(await bg(app, 'aside.sbar.l'), 'the tree sidebar is the page').toBe(page);
  expect(await bg(app, 'aside.dock.l'), 'the tree shows the sidebar through').toBe('rgba(0, 0, 0, 0)');
  expect(await bg(app, '.zh'), 'the tab strip is a panel').toBe(panel);
}

test('page_colour_f6f6f4: light page and rails #f6f6f4 behind white panels, fresh and old store; dark #0d1117 / #151b23', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  await app.emulateMedia({ colorScheme: 'light' });
  await openWindow(app);
  await expectPage(app, RGB['#f6f6f4'], RGB['#ffffff']);
  await app.emulateMedia({ colorScheme: 'dark' });
  await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectPage(app, RGB['#0d1117'], RGB['#151b23']);
});

test('page_colour_f6f6f4 old store: a store from before the version field, with the bundled picks saved, paints the same', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  const { LIGHT_PICK, DARK_PICK } = await import('../src/themes/nunchiro');
  await app.addInitScript(
    ([k, l, d]) => localStorage.getItem(k) ?? localStorage.setItem(k, JSON.stringify({ themeMode: 'system', themeLight: l, themeDark: d, themeFixed: l, density: 'comfortable' })),
    [SETTINGS, LIGHT_PICK, DARK_PICK] as const,
  );
  await app.emulateMedia({ colorScheme: 'light' });
  await openWindow(app);
  await expectPage(app, RGB['#f6f6f4'], RGB['#ffffff']);
});

test('page_colour_f6f6f4 user pick kept: a catalog theme the user picked keeps its own colours', async ({ app, core }) => {
  core.shell(core.project('demo'), 'a');
  const { parseGhostty } = await import('../src/themes/ghostty');
  const { THEMES } = await import('../src/themes/catalog/catalog.gen');
  const pick = { id: 'catalog:Catppuccin Latte', name: 'Catppuccin Latte', colors: parseGhostty(THEMES['Catppuccin Latte']) };
  await app.addInitScript(([k, p]) => localStorage.getItem(k) ?? localStorage.setItem(k, JSON.stringify({ themeMode: 'fixed', themeFixed: p })), [SETTINGS, pick] as const);
  await openWindow(app);
  const probe = (c: string) => app.evaluate((v) => { const d = document.createElement('i'); d.style.color = v; document.body.append(d); const r = getComputedStyle(d).color; d.remove(); return r; }, c);
  expect(await bg(app, '.zh')).toBe(await probe(pick.colors.background)); // ticket 1041: the panel is the tab strip; the tree sits on the page
  const page = await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--page').trim());
  expect(await bg(app, 'nav.ib.l')).toBe(await probe(page));
  expect(await probe(page)).not.toBe(RGB['#f6f6f4']);
  expect((await app.evaluate((k) => JSON.parse(localStorage.getItem(k)!), SETTINGS)).themeFixed.id).toBe('catalog:Catppuccin Latte');
});

const block = (app: Page, project: string) => app.locator(`.grp[data-project="${project}"]`);
/** Session rows and decision lines of a project, in the order drawn: [kind or 'line', text]. */
const drawn = (app: Page, project: string) =>
  block(app, project)
    .locator(':scope > .sess, :scope > .wtwrap .row.wt2, :scope > .row.wt2, :scope > .sess .row.wt2')
    .evaluateAll((els) => els.map((e) => [(e as HTMLElement).dataset.kind ?? 'line', (e.textContent ?? '').trim()]));

test('tree_working_row_arc: a working main-folder session has a row with the blue arc; working-only project too; waiting first', async ({ app, core }) => {
  const p = core.project('demo');
  core.shell(p, 'busy');
  core.shell(p, 'asks');
  const solo = core.project('solo');
  core.shell(solo, 'alone');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('busy', { working: true });
  patch.set('alone', { working: true });
  // Working-only project: its row is there with the arc (repro row 17 drew none).
  const alone = block(app, 'solo').locator('.row.wt2[data-kind="work"]');
  await expect(alone).toHaveCount(1);
  await expect(alone).toContainText('alone');
  // Ticket 1041 lane 4 (08150d02e): rows lose the rail and the working arc; the state is a light (light-glass.css). Working is the blue travelling line.
  await expect(alone).toHaveClass(/\blight-run\b/);
  // Working + waiting in one project: both rows, the waiting one first.
  patch.set('asks', { waiting: true });
  // RC gap 3 (needs 92, needs 95): the waiting main-folder session has its own hand row inside its line's block.
  await expect.poll(() => drawn(app, 'demo')).toEqual([
    ['line', expect.stringContaining('asks')],
    ['hand', expect.stringContaining('asks')],
    ['work', expect.stringContaining('busy')],
  ]);
  // An idle main-folder session still has no row of its own (the head stands for it, V2-CF4).
  patch.set('busy', {});
  await app.mouse.move(900, 600);
  await expect(block(app, 'demo').locator('.row.wt2[data-kind="work"]')).toHaveCount(0);
});

test('tree_head_counts_orange_red: orange your-turn and red broken counts on the head, words only in the tooltip; live under the pointer', async ({ app, core }) => {
  const p = core.project('demo');
  for (const l of ['asks', 'broke', 'busy', 'later']) core.shell(p, l);
  core.shell(core.project('calm'), 'quiet');
  const patch = await patchSnapshots(app);
  await openWindow(app);
  patch.set('asks', { waiting: true });
  patch.set('broke', { failed: true });
  patch.set('busy', { working: true });
  const head = block(app, 'demo').locator('.row.head .r');
  // Ticket 388: the counts are the colour strip's bars (one per session); the words are its hover summary and the label.
  const strip = block(app, 'demo').locator('.row.head .cstrip');
  await expect(strip.locator('.sg[data-tone="o"]')).toHaveAttribute('data-n', '1');
  await expect(strip.locator('.sg[data-tone="r"]')).toHaveAttribute('data-n', '1');
  expect(await strip.locator('.sg').allInnerTexts()).toEqual(['', '', '', '']); // red, orange, blue, grey: bars only
  expect(await head.innerText()).toBe('');
  await expect(head).toHaveAttribute('title', /1 waiting, 1 need attention/);
  await expect(head).toHaveAttribute('aria-label', /1 waiting, 1 need attention/);
  const orange = await strip.locator('.sg[data-tone="o"] i').evaluate((e) => getComputedStyle(e).backgroundColor);
  const red = await strip.locator('.sg[data-tone="r"] i').evaluate((e) => getComputedStyle(e).backgroundColor);
  const tok = (n: string) => app.evaluate((v) => { const d = document.createElement('i'); d.style.color = `var(${v})`; document.body.append(d); const r = getComputedStyle(d).color; d.remove(); return r; }, n);
  // Ticket 462 (owner 11-12): the tree's bars take the approved mockup's palette (--tree-*), solid, no notch.
  expect(orange).toBe(await tok('--tree-you'));
  expect(red).toBe(await tok('--tree-bad'));
  // Zero of each: no orange or red bar.
  await expect(block(app, 'calm').locator('.row.head .sg:is([data-tone="o"], [data-tone="r"])')).toHaveCount(0);
  // needs 49 + TREEHEAD-FREEZE (tree4 r3, owner 2026-11-02): the pointer on a project head freezes what the head draws, counts included; the live
  // label has the new count at once and the pill follows when the pointer leaves.
  await block(app, 'demo').locator('.row.head .n').hover();
  patch.set('later', { waiting: true });
  await expect(head).toHaveAttribute('aria-label', /2 waiting/);
  await expect(strip.locator('.sg[data-tone="o"]')).toHaveAttribute('data-n', '1');
  await app.mouse.move(900, 600);
  await expect(strip.locator('.sg[data-tone="o"]')).toHaveAttribute('data-n', '2');
});

test('no_strip_above_composer: a waiting decision draws nothing between the transcript and the composer; it is answered from its tree row', async ({ app, core }) => {
  fakes(core);
  const p = gitRepo(core, 'demo');
  const a = core.agent(p, 'asks', 'go');
  // A screen-only fake's item is risky in the core (no hook data): the proxy marks it safe as a hooked command would be,
  // so the row offers Allow (decision-rows-seed.ts).
  const px = await proxy(app);
  await openWindow(app);
  await app.locator(`.tab[data-tab="${a.id}"]`).click();
  await showComposer(app); // a session with no transcript yet shows its terminal (fixtures.ts)
  await expect(app.locator('.cbox textarea').first()).toBeVisible();
  // A22: the default layout has no strip zone (it was right above the composer's): nothing takes room there
  // and no strip is drawn.
  const above = () =>
    app.evaluate(() => ({
      zone: Math.round(document.querySelector('[data-zone-id="waiting"]')?.getBoundingClientRect().height ?? 0),
      strips: document.querySelectorAll('#waiting-strip, [aria-label="Answer strip"]').length,
    }));
  expect(await app.evaluate(() => !!document.querySelector('[data-zone-id="waiting"] + * [data-zone-id="composer"], [data-zone-id="waiting"] ~ [data-zone-id="composer"]'))).toBe(false); // was true: A22, the default layout has no strip zone at all
  expect(await above()).toEqual({ zone: 0, strips: 0 });
  show(a.cwd, 'go', PERMISSION('touch out-a'));
  // The decision is on its tree row...
  const line = block(app, 'demo').locator('.sess');
  await expect(line).toContainText('asks', { timeout: 15_000 });
  // ...and nothing appeared above the composer.
  expect(await above()).toEqual({ zone: 0, strips: 0 });
  await expect(app.getByRole('region', { name: 'Answer strip' })).toHaveCount(0);
  // Answered from the row's visible, labelled control.
  await line.getByRole('button', { name: /^Allow/ }).click();
  await expect.poll(() => core.read(a.id), { timeout: 15_000 }).toContain('answered 1');
  expect(px.sent.map((x) => x.answer.type)).toEqual(['allow_once']);
  await expect(line).toHaveCount(0, { timeout: 15_000 });
});

test('diff_one_control: one Diff control on the screen (the bar icon); diff.open still opens the Diff widget', async ({ app, core }) => {
  core.agent(core.project('demo'), 'a', 'never');
  await openWindow(app);
  const controls = app.getByRole('button', { name: 'Diff', exact: true });
  await expect(controls).toHaveCount(1);
  await expect(app.locator('nav.ib.r').getByRole('button', { name: 'Diff', exact: true })).toHaveCount(1);
  // The visible control opens it.
  await controls.click();
  await expect(app.getByRole('complementary', { name: 'Diff' })).toBeVisible();
  await controls.click();
  await expect(app.getByRole('complementary', { name: 'Diff' })).toHaveCount(0);
  // The shortcut's command still opens it.
  await app.evaluate((ev) => window.dispatchEvent(new CustomEvent(ev, { detail: {} })), DIFF_OPEN);
  await expect(app.getByRole('complementary', { name: 'Diff' })).toBeVisible();
});

export type { Core };
