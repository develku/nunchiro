// Q4 speed rows, driven by interact.py (job JSON in argv[2]). Each row: `repeats` presses, each timed from the press's
// pointerdown (or keydown) event timestamp to the end of the first frame whose DOM shows the result: a requestAnimationFrame
// callback finds the row's "painted" condition true, and a MessageChannel task posted from that callback runs after the
// browser finished that frame's style, layout and paint (the frame that shows it). A press that paints nothing in 5 s
// counts as 5000 ms. The scroll row records every frame's interval while the wheel scrolls a long chat for 3 s.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const web = path.resolve(import.meta.dirname, '../../web');
const { webkit, chromium } = createRequire(path.join(web, 'package.json'))('@playwright/test');
const MISS = 5000;
const launch = job.engine === 'webkit'
  ? () => webkit.launch()
  : () => chromium.launch({ headless: false, args: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] });

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
await page.addInitScript((b) => { window.__NUNCHIRO__ = b; }, { port: job.port, token: job.token });
// The probe: armed before a press, it starts the clock at the press's first pointerdown/keydown and stops it at the end of
// the first frame in which `cond` holds. cond = { sel, text?, min? }: an element matching `sel` that is rendered (has a
// box), whose text contains `text`, and at least `min` matches. No eval: the page's CSP forbids it.
await page.addInitScript(() => {
  const w = window;
  const holds = (c) => {
    const els = [...document.querySelectorAll(c.sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (els.length < (c.min ?? 1)) return false;
    return c.text ? els.some((e) => e.textContent.includes(c.text)) : true;
  };
  w.__probe = { holds };
  const start = (e) => { const p = w.__probe; if (p.armed && p.t0 === null) p.t0 = e.timeStamp; };
  addEventListener('pointerdown', start, true);
  addEventListener('keydown', start, true);
  w.__arm = (cond) => {
    const p = w.__probe;
    Object.assign(p, { armed: true, t0: null });
    p.done = new Promise((resolve) => {
      const give = setTimeout(() => { p.armed = false; resolve(null); }, 5000);
      const tick = () => {
        if (p.t0 !== null && holds(cond)) {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => { clearTimeout(give); p.armed = false; resolve(performance.now() - p.t0); };
          ch.port2.postMessage(0);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };
});

const connected = () => page.getByRole('status').filter({ hasText: /connected/i }).first().waitFor({ timeout: 30000 });
await page.goto(job.url);
await connected();

const has = (cond) => page.evaluate((c) => window.__probe.holds(c), cond);
const until = async (cond, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await has(cond)) return; await page.waitForTimeout(50); }
  await page.screenshot({ path: job.out.replace(/\.json$/, '-until.png') }).catch(() => {});
  fs.writeFileSync(job.out.replace(/\.json$/, '-until.html'), await page.content());
  throw new Error(`not shown in ${ms} ms: ${JSON.stringify(cond)}`);
};
/** A real press (pointerdown, up) at the centre of the first rendered match of `sel`. */
const press = async (sel) => {
  const loc = page.locator(sel).first();
  await loc.scrollIntoViewIfNeeded(); // an overflowing tab strip scrolls its tab into view first (before the clock starts)
  const box = await loc.boundingBox();
  if (!box) throw new Error(`nothing to press: ${sel}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
};
/** One timed press: arm the probe for `cond`, run `act`, wait for the frame. */
const timed = async (cond, act) => {
  await page.evaluate((c) => window.__arm(c), cond);
  await act();
  const ms = await page.evaluate(() => window.__probe.done);
  return ms ?? MISS;
};
const settle = () => page.waitForTimeout(150);

// What each kind of tab shows once painted.
const termDrawn = (id, label) => ({ sel: `.term[data-session="${id}"]:not([hidden]) .xterm-rows`, text: `FIXTURE_READY ${label}` });
const chatDrawn = (id) => ({ sel: `.chat[data-session="${id}"] .clist[aria-busy="false"] .crow` });
const treeRow = (id) => `.tree .row.wt2[data-menu-session="${id}"]`;
const tab = (id) => `.tab[data-tab="${id}"]`;
const closeTab = async (id) => {
  if (!(await page.locator(tab(id)).count())) return;
  await page.locator(tab(id)).click({ button: 'middle' });
  await page.locator(tab(id)).waitFor({ state: 'detached', timeout: 5000 });
};
const show = async (id, cond) => { await press(tab(id)); await until(cond); await settle(); };
/** Before an open: the session is shown (its project's strip), its tab closed there, then shop-t0 shown from the tree. */
const closeFromTree = async (id, cond) => {
  await press(treeRow(id));
  await until(cond, 30000);
  await closeTab(id);
  await press(treeRow(T['shop-t0']));
  await until(termDrawn(T['shop-t0'], 'shop-t0'));
  await page.waitForTimeout(300);
};

const T = job.terms, C = job.chats;
const shopTerms = Object.keys(T).filter((l) => l.startsWith('shop-'));
const otherTerms = Object.keys(T).filter((l) => !l.startsWith('shop-'));
const rows = {};
const want = (name) => !job.only?.length || job.only.some((p) => name.startsWith(p));

let cdp = null;
const profiled = async (name, fn) => {
  if (job.profile !== name || job.engine !== 'chromium') return fn();
  cdp = await context.newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await fn();
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
  });
  rows[name].top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]);
};
const row = async (name, what, fn) => {
  if (!want(name)) return;
  rows[name] = { what, ms: [] };
  try {
    await profiled(name, () => fn(rows[name].ms));
  } catch (e) {
    rows[name].error = String(e.message ?? e).split('\n')[0];
    await page.screenshot({ path: job.out.replace(/\.json$/, `-${name}-error.png`) }).catch(() => {});
  }
  const r = rows[name];
  console.log(`${job.engine} ${name}: ${r.error ?? `${r.ms.length} repeats`}`);
};

// Start in the shop project, on a terminal.
await press(treeRow(T['shop-t0']));
await until(termDrawn(T['shop-t0'], 'shop-t0'));

await row('open-terminal', 'press on a tree row of a terminal session of another project whose tab is closed, until its tab shows the xterm rows with the session\'s last line', async (ms) => {
  // Each repeat: a terminal of another project is opened from the tree, measured, then its tab closed again.
  for (let i = 0; i < job.repeats; i++) {
    const label = otherTerms[i % otherTerms.length];
    await closeFromTree(T[label], termDrawn(T[label], label));
    ms.push(await timed(termDrawn(T[label], label), () => press(treeRow(T[label]))));
    await settle();
  }
});

await row('open-chat', 'press on a tree row of a chat session of another project (or shop\'s chat-a) whose tab is closed, until its chat list is loaded (aria-busy false) with rows on screen', async (ms) => {
  const labels = ['chat-a', 'chat-b', 'chat-c', 'chat-d'];
  for (let i = 0; i < job.repeats; i++) {
    const label = labels[i % labels.length];
    await closeFromTree(C[label], chatDrawn(C[label]));
    ms.push(await timed(chatDrawn(C[label]), () => press(treeRow(C[label]))));
    await settle();
  }
});

// The shop strip for the switch rows: a terminal, a short chat and the long chat open.
for (const [id, cond] of [[C['chat-a'], chatDrawn(C['chat-a'])], [C.history, chatDrawn(C.history)], [T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0')]]) {
  if (!(await page.locator(tab(id)).count())) await press(treeRow(id));
  else await press(tab(id));
  await until(cond, 30000);
  await settle();
}

const pair = (a, condA, b, condB) => async (ms, back) => {
  for (let i = 0; i < job.repeats; i++) {
    await show(a, condA);
    ms.push(await timed(condB, () => press(tab(b))));
    await settle();
    if (back) back.push(await timed(condA, () => press(tab(a))));
    await settle();
  }
};
await row('switch-terminal-to-chat', 'press on the tab of an open chat (a terminal tab active), until the chat list shows its rows', async (ms) => {
  rows['switch-chat-to-terminal'] = { what: 'press on the tab of an open terminal (a chat tab active), until its xterm rows show the session\'s last line', ms: [] };
  await pair(T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0'), C['chat-a'], chatDrawn(C['chat-a']))(ms, want('switch-chat') ? rows['switch-chat-to-terminal'].ms : null);
  if (!want('switch-chat')) delete rows['switch-chat-to-terminal'];
});
await row('switch-chat-to-long-chat', `press on the tab of the open ${job.long_events}-event chat (a short chat active), until its chat list shows its rows`, pair(C['chat-a'], chatDrawn(C['chat-a']), C.history, chatDrawn(C.history)));

const gear = 'nav[aria-label="Left bar"] button[aria-label="Settings"]';
const settingsDrawn = { sel: '[role="dialog"] .settings .spage h1' };
const closeSettings = async () => {
  await page.getByRole('button', { name: 'Close Settings' }).click();
  await page.locator('.settings').waitFor({ state: 'detached', timeout: 5000 });
  await settle();
};
await row('settings-cold', 'press on the Left bar Settings button, first time in the page\'s life (a reload before each), until the Settings page heading shows', async (ms) => {
  for (let i = 0; i < job.repeats; i++) {
    await page.reload();
    await connected();
    await until({ sel: '.tab[aria-selected="true"]' }, 30000); // the reload restores the last active tab
    await page.waitForTimeout(1000);
    ms.push(await timed(settingsDrawn, () => press(gear)));
    await closeSettings();
  }
});
await row('settings-warm', 'press on the Left bar Settings button after it was open before, until the Settings page heading shows', async (ms) => {
  for (let i = 0; i < job.repeats; i++) {
    ms.push(await timed(settingsDrawn, () => press(gear)));
    await closeSettings();
  }
});

const boardBtn = '.ib.r .aiw[data-icon="board"] button';
await row('board-open', 'press on the right bar\'s Board button, until the Board shows its session cards', async (ms) => {
  for (let i = 0; i < job.repeats; i++) {
    ms.push(await timed({ sel: '.board [data-menu-session]', min: 1 }, () => press(boardBtn)));
    await settle();
    await page.keyboard.press('Escape');
    await page.locator('.board').first().waitFor({ state: 'detached', timeout: 5000 }).catch(async () => { await press(boardBtn); });
    await settle();
  }
});

const chip = '.shead [data-team-chip]';
const teamDrawn = { sel: '.teamv[data-where="side"] .lead-row[data-task]', min: 2 };
const teamIcon = 'nav[data-bar="right"] [data-icon="team"] .ai';
await row('team-open', 'press on the lead\'s "2 tasks" chip (the Team view closed), until the Team view at the side shows both task rows', async (ms) => {
  await show(job.lead, { sel: chip });
  for (let i = 0; i < job.repeats; i++) {
    ms.push(await timed(teamDrawn, () => press(chip)));
    await settle();
    await press(teamIcon);
    await page.locator('.teamv').first().waitFor({ state: 'detached', timeout: 5000 });
    await settle();
  }
});
await row('team-room', 'press on the Team view\'s Room tab (Tasks shown), until the room\'s chat shows', async (ms) => {
  await show(job.lead, { sel: chip });
  if (!(await page.locator('.teamv').count())) { await press(chip); await until(teamDrawn); }
  for (let i = 0; i < job.repeats; i++) {
    ms.push(await timed({ sel: '.teamv[data-where="side"] .teamv-room .room-chat' }, () => press('#teamv-side-room-tab')));
    await settle();
    await press('#teamv-side-tasks-tab');
    await until(teamDrawn);
    await settle();
  }
});

await row('scroll-long-chat', 'mouse wheel up over the long chat (Verbose view) for 3 s, from its end, 3 runs: every animation frame\'s interval (ms)', async (ms) => {
  rows['scroll-long-chat'].frames = true;
  const runs = Math.max(1, Math.round(job.repeats / 10));
  rows['scroll-long-chat'].repeats = runs;
  rows['scroll-long-chat'].rows = [];
  for (let r = 0; r < runs; r++) {
    await show(C.history, chatDrawn(C.history));
    // Verbose: every call is its own row (Normal folds a turn's calls into one summary row: about 190 rows for 5,000 events).
    const cycle = page.locator(`.chat[data-session="${C.history}"] .cview button`);
    for (let i = 0; i < 4 && !/Verbose/.test((await cycle.getAttribute('aria-label')) ?? ''); i++) await cycle.click();
    await until(chatDrawn(C.history));
    const list = page.locator(`.chat[data-session="${C.history}"] .cscroll`);
    await list.evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await settle();
    const box = await list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => { const w = window; w.__frames = []; w.__framing = true; w.__keys = new Set(); const f = (t) => { if (!w.__framing) return; w.__frames.push(t); for (const r of document.querySelectorAll('.chat:not([aria-hidden="true"]) .crow')) w.__keys.add(r.dataset.key); requestAnimationFrame(f); }; requestAnimationFrame(f); });
    const end = Date.now() + 3000;
    while (Date.now() < end) { await page.mouse.wheel(0, -120); await page.waitForTimeout(16); }
    const ts = await page.evaluate(() => { window.__framing = false; return window.__frames; });
    // Distinct rows drawn during the 3 s (the list is virtualised and pages older events in as it nears the top).
    rows['scroll-long-chat'].rows.push(await page.evaluate(() => window.__keys.size));
    for (let i = 1; i < ts.length; i++) ms.push(ts[i] - ts[i - 1]);
  }
});

await browser.close();
fs.writeFileSync(job.out, JSON.stringify({ rows }));
