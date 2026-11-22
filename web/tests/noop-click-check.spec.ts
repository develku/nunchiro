// ticket 291 item 3 (needs 210): the no-op click check. In each state of web/tests/ux-states.ts (at 1440 px) every visible
// clickable (the dead-click spec's definition) is clicked once, with the mouse at its centre. The click passes when it
// changes the DOM (a mutation observer), the focus, the route, opens a popup, or sends a request (the window's socket log,
// or an HTTP request). A click that does none of these is an offender `<state>|<css path>|<text or aria-label, 24 chars>`.
// A click that changed something leaves the state dirty: the next click starts from a fresh window (state.enter again),
// so one click cannot hide another. scripts/noop-click.baseline lists today's offenders (scripts/noop-click-check.sh).
// One test per state (they run in parallel), each writing .scratch/noop-click.found.<state>. NOOP_WRITE=1 only writes those
// files and asserts nothing: the first generation is `cat .scratch/noop-click.found.* | sort -u > scripts/noop-click.baseline`.
// NOOP_BASELINE names another baseline file (the scenario test points it at an empty one to see every offender of an old build).
//
// A choice that is already selected (aria-checked, aria-pressed or aria-selected true) is not clicked: a second click on it is
// meant to change nothing (V2.5-34). The list and that rule live in noop-click-scan.ts.
//
// Safety (strict layer): this runs in a test window against a fake core. The controls below are never clicked, and the
// window's socket drops any answer-path request (`answer`, `send_text`, `send_keys`) before it reaches the core.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './fixtures';
import { list } from './noop-click-scan';
import { expect, openApp, seed, STATES, test, type Ctx, type Ux } from './ux-states';

// Round 2: one worker per state (each test has its own core and window), so the walk takes the longest state, not the sum.
test.describe.configure({ mode: 'parallel' });

const BASELINE = process.env.NOOP_BASELINE ?? path.join(REPO, 'scripts/noop-click.baseline');
const FOUND = (state: string) => path.join(REPO, `.scratch/noop-click.found.${state}`);

// Named skip list: a control matched here is not clicked. Each has its reason.
const SKIP = [
  '.deccard', // the Decisions card: allow, deny and choose answer a decision of a live agent
  '.dc-item', // one decision inside it
  '[data-act="allow"], [data-act="deny"], [data-act="choose"], [data-act="answer"]', // answer buttons wherever they sit (tree rows, sheets)
  '.ps', // the permission sheet: its buttons grant or refuse a permission
  '.send', // the composer's send: sends text to an agent
  ':disabled, [aria-disabled="true"]', // disabled by design: a click is meant to do nothing
  'input[type="file"]', // opens the system file chooser
  '.qib, .q', // the tree's answer rows (Allow, Deny, Details): same reason as the Decisions card
  '.sdiv, .sgutter, .bdiv', // sidebar, split and icon bar edge resize handles: they are dragged, a plain click on them is meant to do nothing
  '.bchip', // the Browser widget's space chip: a native <select> covers it, and opening its list is an OS popup the page cannot see (WebKit does not focus a select on click; the window's beat used to read as its effect, lane w89)
  '[data-command]', // command palette rows: each runs an app command (stop, close, quit), one test window per state is not enough to undo them
].join(', ');

// Round 2 (gate cost): the window's shared chrome (title bar, icon bars, status line) is on every screen, so it is clicked once, in the `default` state, and
// skipped in the other states (same control, same handler; the state changes what is beside it, not what it does). The two
// overlay states keep it: there a menu or the palette lies over the chrome, and a covered control is what they look for.
// The session tabs (.zh) and the tree dock (aside.dock) differ per state, so they are clicked in every state.
const CHROME = 'header.title, nav.ib, footer.status';
/** Requests the window sends on its own timer, whatever is clicked. */
const BACKGROUND = new Set(['queue_connect']);
const WHOLE = new Set(['default', 'context-menu', 'palette']);
// v25f: Settings and the Board are a modal; a control behind it takes no user click (the mouse lands on the modal), so it is not walked.
// Written to match nothing inside the modal and nothing that contains it (the skip test also checks every ancestor).
const BEHIND_MODAL = 'body:has(.ovl) :not(.ovl, .ovl *):not(:has(.ovl))';

/** Moves the mouse onto entry `key`, watches for 250 ms of background change, clicks, watches 300 ms. Null: not clickable now. */
async function clickOne(c: Ctx, key: string) {
  const { page } = c;
  const T = (m: string) => process.env.NOOP_TRACE && console.log(`  ${m} ${key}`);
  T('find');
  const pos = await page.evaluate((key) => {
    const ux = (window as unknown as { __ux: Ux }).__ux;
    const seen = new Map<string, number>();
    for (const el of ux.clickables()) {
      const base = `${ux.css(el)}|${ux.label(el)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      if (`${base}#${n}` !== key) continue;
      (el as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      // Where a user would press: the centre, else the first point of a 3x3 grid that the control itself is on top at (an open
      // menu's edge can lie over half of a button: real-app 11-10, the tab's Stop under the tab's menu). A wholly covered
      // control is still pressed at its centre, so a covered no-op is still found.
      const on = (x: number, y: number) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
      const grid = [0.5, 0.25, 0.75].flatMap((fy) => [0.5, 0.25, 0.75].map((fx) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy })));
      const { x, y } = grid.find((p) => on(p.x, p.y)) ?? grid[0];
      return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? { x, y } : null;
    }
    return null;
  }, key);
  if (!pos) return null;
  T('move');
  await page.mouse.move(pos.x, pos.y);
  await page.waitForTimeout(100); // a hover tooltip or style appears before the baseline is taken
  await page.evaluate(([x, y]) => {
    const w = window as unknown as { __noop: { noisy: WeakSet<Node>; real: number; focus: Element | null; target: Element | null; href: string; hist: number; on: boolean } };
    const st = (w.__noop = { noisy: new WeakSet(), real: 0, focus: document.activeElement, target: document.elementFromPoint(x, y), href: location.href, hist: history.length, on: false });
    new MutationObserver((ms) => {
      for (const m of ms) {
        // Background change (a timer, a clock): the node that changed before the click does not count for it.
        if (!st.on) st.noisy.add(m.target);
        else if (!st.noisy.has(m.target)) st.real++;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }, [pos.x, pos.y]);
  T('observe');
  await page.waitForTimeout(150);
  const sent0 = c.sent.length;
  const blocked0 = c.blocked.length;
  const http0 = c.http;
  const popups0 = c.popups;
  await page.evaluate(() => ((window as unknown as { __noop: { on: boolean } }).__noop.on = true));
  T('down');
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(250);
  // The window's own beat (queue_connect, every second: queue/connect.ts) is no effect of the click: counted, it read a dead
  // button as live whenever the beat fell inside the 250 ms (WebKit beside other tests: 3 of 6 red, lane w89).
  const sent = c.sent.slice(sent0).filter((r) => !BACKGROUND.has(r.op)).length;
  const requests = sent + c.blocked.length - blocked0 + (c.http - http0) + (c.popups - popups0);
  T('read');
  const changed = await page
    .evaluate(() => {
      const st = (window as unknown as { __noop: { real: number; focus: Element | null; target: Element | null; href: string; hist: number } }).__noop;
      // A click focuses the button it lands on: that alone is no effect. Focus that went somewhere else is.
      const a = document.activeElement;
      const moved = a !== st.focus && a !== st.target && !(st.target && st.target.contains(a));
      return st.real > 0 || moved || location.href !== st.href || history.length !== st.hist;
    })
    .catch(() => true); // the page went away: the click navigated
  return { moved: changed || requests > 0 };
}

/**
 * Waits until the controls stop moving. A reopened tab draws its composer box narrow for about 50 ms and then at full
 * width; a position read in between is where the text box is 250 ms later, so the click missed its button and the
 * button read as a no-op (nightly 11-17: Commands and skills, Stashed drafts).
 *
 * Each read waits for two frames first (lane w69). The narrow box is a layout no frame shows: the composer keeps the old
 * `--pane-room` until SidePane's resize observer runs, which is in the next frame. Beside another test a frame took longer
 * than the 80 ms between reads, so two reads agreed on the narrow box and the click went to where the button had been
 * (decisions: 3 of 3 runs red with two copies side by side).
 */
async function settled(page: Ctx['page']) {
  let last = '';
  for (let i = 0; i < 20; i++) {
    const now = await page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [...document.querySelectorAll('button, textarea')].map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)}`; }).join(';');
    });
    if (now === last) return;
    last = now;
    await page.waitForTimeout(80);
  }
}

function ratchet(state: string, found: string[]) {
  const now = [...new Set(found)].sort();
  fs.mkdirSync(path.dirname(FOUND(state)), { recursive: true });
  fs.writeFileSync(FOUND(state), now.map((l) => `${l}\n`).join(''));
  if (process.env.NOOP_WRITE) return;
  const r = spawnSync('sh', [path.join(REPO, 'scripts/noop-click-check.sh'), BASELINE, FOUND(state)], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
}

// Synthetic (not the RC2c build): the chat's "Answer in Decisions" row dispatched an event nobody heard (owner, 11-04), so the
// click changed nothing. On RC2c ff220558 the real button still works in these fixtures (the widget is in the default
// layout), so the dead case is pinned here with a page of its own. This does not prove the old build.
test('noop_click_check_catches_answer_in_decisions', async ({ page, chatCore }) => {
  const c = await seed(page, chatCore, true);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate(() => {
    document.body.innerHTML = `<style>button,a{cursor:pointer;display:block;width:140px;height:24px}</style>
      <div class="dline"><button id="dead">Answer in Decisions</button></div>
      <button id="live">Open</button><button id="focus">Focus</button><input id="field">`;
    // The dead one: an event with no listener. The live one adds a node; the third moves the focus to another element.
    document.getElementById('dead')!.onclick = () => window.dispatchEvent(new CustomEvent('nunchiro:decisions.open', { detail: { session: 'x' } }));
    document.getElementById('live')!.onclick = () => document.body.append(document.createElement('hr'));
    document.getElementById('focus')!.onclick = () => document.getElementById('field')!.focus();
  });
  const got = (await list(page, SKIP)).map((e) => e.key);
  const result: Record<string, boolean> = {};
  for (const k of got) result[k] = (await clickOne(c, k))!.moved;
  expect(Object.entries(result).map(([k, v]) => `${k.split('|')[1].split('#')[0]}:${v}`)).toEqual(['Answer in Decisions:false', 'Open:true', 'Focus:true']);
});

/**
 * Clicks every entry once and returns the `line` of each that did nothing. A selected choice (aria-checked, aria-pressed or
 * aria-selected true) is not clicked while the walk can show its attribute is live: a click elsewhere turned it off (the
 * sibling choice of a radio group or tab strip). A static `aria-pressed="true"` never turns off, so it is clicked last.
 */
async function walk(c: Ctx, skip: string, enter: () => Promise<void>) {
  await settled(c.page); // the first click too: the state was entered a moment ago
  const all = (await list(c.page, skip)).filter((e) => !e.skip);
  const selected = new Set(all.filter((e) => e.selected).map((e) => e.key));
  const live = new Set<string>();
  const found: string[] = [];
  let dirty = false;
  const click = async (e: { key: string; line: string }) => {
    if (dirty) {
      if (process.env.NOOP_TRACE) console.log('  enter');
      await enter();
      await settled(c.page);
      dirty = false;
    }
    const t0 = Date.now();
    const r = await clickOne(c, e.key);
    if (process.env.NOOP_TRACE) console.log(`${Date.now() - t0}ms ${r ? (r.moved ? 'moved' : 'NOOP') : 'gone'} ${e.key}`);
    if (!r) return; // gone after the last fresh start (an earlier click removed it), or off screen
    if (r.moved) {
      dirty = true;
      for (const n of await list(c.page, skip).catch(() => [])) if (selected.has(n.key) && !n.selected) live.add(n.key);
    } else found.push(e.line);
  };
  for (const e of all.filter((e) => !e.selected)) await click(e);
  for (const e of all.filter((e) => e.selected && !live.has(e.key))) await click(e); // never seen to change: click it like any other
  return found;
}

for (const state of STATES)
  test(`noop_click_gate: ${state.name} passes against scripts/noop-click.baseline`, async ({ page, chatCore }) => {
    test.setTimeout(8 * 60_000);
    const c = await seed(page, chatCore, true);
    await page.setViewportSize({ width: 1440, height: 800 });
    await state.enter(c);
    const found = await walk(c, `${WHOLE.has(state.name) ? SKIP : `${SKIP}, ${CHROME}`}, ${BEHIND_MODAL}`, () => state.enter(c));
    ratchet(state.name, found.map((l) => `${state.name}|${l}`));
  });

// V2.5-34 round 2: skipping a selected choice must not hide a dead handler. A static aria-pressed="true" with no handler is caught;
// a toggle whose aria-pressed flips on click is not; a radio that the walk saw turn off (its sibling was clicked) is not clicked.
test('noop_click_static_pressed_still_caught', async ({ page, chatCore }) => {
  const c = await seed(page, chatCore, true);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.evaluate(() => {
    document.body.innerHTML = `<style>button{cursor:pointer;display:block;width:140px;height:24px}</style>
      <button id="static" aria-pressed="true">Static</button>
      <button id="toggle" aria-pressed="true">Toggle</button>
      <div role="radiogroup"><button id="ra" role="radio" aria-checked="true">RadioA</button><button id="rb" role="radio" aria-checked="false">RadioB</button></div>`;
    const flip = (el: Element, a: string) => el.setAttribute(a, el.getAttribute(a) === 'true' ? 'false' : 'true');
    document.getElementById('toggle')!.onclick = (e) => flip(e.currentTarget as Element, 'aria-pressed');
    document.getElementById('rb')!.onclick = () => (flip(document.getElementById('ra')!, 'aria-checked'), flip(document.getElementById('rb')!, 'aria-checked'));
    // RadioA has no handler of its own: it is skipped only because RadioB's click turned it off.
  });
  // The window's heartbeat (queue_connect, and the Board rail's board_snapshot count poll; each about once a second) is not a click's effect: leave it out of the request count, or a dead click
  // that lands on a beat reads as live.
  const push = c.sent.push.bind(c.sent);
  c.sent.push = (...m) => push(...m.filter((x) => x.op !== 'queue_connect' && x.op !== 'board_snapshot'));
  const found = await walk(c, '.never', async () => {});
  expect(found.map((l) => l.split('|')[1])).toEqual(['Static']);
});

// V2.5-41: openApp waits for the seeded tabs it needs, and when they do not come its failure says how many it saw and how many
// are missing (it used to say only "Expected: >= 3, Received: 2"). Asking for more tabs than the core has seeded shows the text.
test('open_app_reports_tab_count', async ({ page, chatCore }) => {
  const c = await seed(page, chatCore, true);
  await page.setViewportSize({ width: 1440, height: 800 });
  const err = await openApp(c, 5, 1500).then(() => null, (e: Error) => e.message);
  expect(err).toMatch(/openApp: 3 of 5 seeded tabs/);
  expect(err).toMatch(/2 missing/);
});
