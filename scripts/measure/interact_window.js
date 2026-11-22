// Q4 speed rows inside the release app's own window (WKWebView), driven by interact_window.py. Never part of a normal
// build: interact_window.py copies this file into its own copy of the web bundle and embeds that copy in a measure-only
// app binary. It runs the rows of interact.mjs (same "painted" end conditions) plus the long-chat, composer, B17 and
// lead-row rows, and sends each row to the harness's WebSocket sink on 127.0.0.1 (window.__Q4W_SINK__, written above
// this file by the harness). Presses are synthetic DOM events (pointerdown, mousedown, focus, pointerup, mouseup, click)
// at the centre of the element, dispatched on what elementFromPoint hits there; a key is keydown, the edit through
// execCommand('insertText'), keyup. Timing (makeProbe): the clock starts at the press's pointerdown/keydown timeStamp and
// stops in a task posted from the first animation frame whose DOM shows the result, after that frame's paint.
// Settings cold reloads the page before each press: progress lives in sessionStorage and the page reconnects to the sink.

/** The timing core, separate from the DOM so interact_window.test.mjs can drive it with a fake clock and frames. */
function makeProbe({ now, raf, post, after, holds, miss = 5000 }) {
  const p = { armed: false, t0: null };
  /** Called by the capture listener of pointerdown and keydown: the first one after arm() starts the clock. */
  p.start = (stamp) => {
    if (!p.armed || p.t0 !== null) return;
    const n = now();
    // A synthetic event's timeStamp is its creation time on the performance clock; anything else uses now().
    p.t0 = stamp > 0 && stamp <= n ? stamp : n;
  };
  /** Resolves with ms from the press to the end of the first frame where cond holds, or null after `miss` ms. */
  p.arm = (cond) => {
    Object.assign(p, { armed: true, t0: null });
    return new Promise((resolve) => {
      let over = false;
      const cancel = after(miss, () => { over = true; p.armed = false; resolve(null); });
      const tick = () => {
        if (over) return;
        if (p.t0 !== null && holds(cond)) {
          post(() => { if (over) return; over = true; cancel(); p.armed = false; resolve(now() - p.t0); });
          return;
        }
        raf(tick);
      };
      raf(tick);
    });
  };
  return p;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.__Q4W_SINK__) (() => {
  const KEY = 'nunchiro.q4w';
  const state = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } })() || { done: [], cold: [] };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));

  const rendered = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const holds = (c) => {
    if (c.gone && [...document.querySelectorAll(c.gone)].some(rendered)) return false;
    const els = [...document.querySelectorAll(c.sel)].filter(rendered);
    if (els.length < (c.min ?? 1)) return false;
    if (c.value !== undefined && !els.some((e) => e.value === c.value)) return false;
    return c.text ? els.some((e) => e.textContent.includes(c.text)) : true;
  };
  const probe = makeProbe({
    now: () => performance.now(),
    raf: (f) => requestAnimationFrame(f),
    post: (f) => { const ch = new MessageChannel(); ch.port1.onmessage = f; ch.port2.postMessage(0); },
    after: (ms, f) => { const t = setTimeout(f, ms); return () => clearTimeout(t); },
    holds,
  });
  addEventListener('pointerdown', (e) => probe.start(e.timeStamp), true);
  addEventListener('keydown', (e) => probe.start(e.timeStamp), true);

  // The sink: a job in, rows out; {shot} waits for the harness's go-ahead.
  let ws = null; const inbox = []; let waiting = null;
  const connect = () => new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${window.__Q4W_SINK__}`);
    ws.onmessage = (m) => { if (waiting) { const w = waiting; waiting = null; w(m.data); } else inbox.push(m.data); };
    ws.onerror = () => reject(new Error('sink unreachable'));
    ws.onopen = () => resolve();
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => { waiting = r; }));
  const send = (o) => ws.send(JSON.stringify(o));
  const log = (text) => send({ log: text });
  const shot = async (name) => { send({ shot: name }); await next(); };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = () => sleep(150);
  const first = (sel) => [...document.querySelectorAll(sel)].find(rendered) ?? null;
  const until = async (cond, ms = 15000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (holds(cond)) return; await sleep(50); }
    throw new Error(`not shown in ${ms} ms: ${JSON.stringify(cond)}`);
  };
  const gone = async (sel, ms = 5000) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (!first(sel)) return; await sleep(50); }
    throw new Error(`still shown after ${ms} ms: ${sel}`);
  };
  /** A button (or any element) by its aria-label or its own text, inside `within`. */
  const byName = (name, within = '') => [...document.querySelectorAll(`${within} button, ${within} [role="button"], ${within} [role="tab"]`)]
    .find((e) => rendered(e) && ((e.getAttribute('aria-label') ?? '').trim() === name || e.textContent.trim() === name)) ?? null;

  const mouse = (type, x, y, button, target) => {
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button, buttons: type.endsWith('down') ? (button === 1 ? 4 : 1) : 0 };
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    const extra = type.startsWith('pointer') ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {};
    return target.dispatchEvent(new Ctor(type, { ...init, ...extra }));
  };
  /** One synthetic press at the centre of `el` (a selector or an element): what a real pointer would hit there gets the events. */
  const press = async (el, button = 0) => {
    let e = typeof el === 'string' ? first(el) : el;
    // As Playwright's locator does: wait (up to 15 s) for the element; the clock starts only at the pointerdown.
    for (let end = performance.now() + 15000; !e && typeof el === 'string' && performance.now() < end; e = first(el)) await sleep(50);
    if (!e) throw new Error(`nothing to press: ${el}`);
    e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const t = hit && (hit === e || e.contains(hit)) ? hit : e;
    mouse('pointerdown', x, y, button, t);
    if (mouse('mousedown', x, y, button, t) && button === 0) {
      const f = t.closest('button, a[href], input, textarea, select, [tabindex]');
      if (f && f !== document.activeElement) f.focus({ preventScroll: true });
    }
    mouse('pointerup', x, y, button, t);
    mouse('mouseup', x, y, button, t);
    mouse(button === 0 ? 'click' : 'auxclick', x, y, button, t);
  };
  const key = (k, target = document.activeElement || document.body) => {
    const init = { key: k, code: /^[A-Za-z]$/.test(k) ? `Key${k.toUpperCase()}` : k.length > 1 ? k : '', bubbles: true, cancelable: true, composed: true };
    const go = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (go && k.length >= 1 && !['Escape', 'Enter', 'Backspace'].includes(k)) document.execCommand('insertText', false, k);
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  };
  /** One timed press: arm the probe for `cond`, act, wait for the frame. A miss counts as 5000 ms. */
  const timed = async (cond, act) => {
    const done = probe.arm(cond);
    await act();
    return (await done) ?? 5000;
  };

  const connected = () => until({ sel: '[role="status"]', text: 'onnected' }, 30000); // interact.mjs: /connected/i

  const run = async () => {
    await connect();
    const job = JSON.parse(await next());
    const T = job.terms, C = job.chats;
    const otherTerms = Object.keys(T).filter((l) => !l.startsWith('shop-'));
    const termDrawn = (id, label) => ({ sel: `.term[data-session="${id}"]:not([hidden]) .xterm-rows`, text: `FIXTURE_READY ${label}` });
    const chatDrawn = (id) => ({ sel: `.chat[data-session="${id}"] .clist[aria-busy="false"] .crow` });
    const treeRow = (id) => `.tree .row.wt2[data-menu-session="${id}"]`;
    const tab = (id) => `.tab[data-tab="${id}"]`;
    const closeTab = async (id) => {
      if (!first(tab(id))) return;
      await press(tab(id), 1);
      await gone(tab(id));
    };
    const show = async (id, cond) => { await press(first(tab(id)) ? tab(id) : treeRow(id)); await until(cond, 30000); await settle(); };
    const closeFromTree = async (id, cond) => {
      await press(treeRow(id));
      await until(cond, 30000);
      await closeTab(id);
      await press(treeRow(T['shop-t0']));
      await until(termDrawn(T['shop-t0'], 'shop-t0'));
      await sleep(300);
    };
    const rows = {};
    const want = (name) => !job.only?.length || job.only.some((p) => name.startsWith(p));
    const row = async (name, what, fn) => {
      if (!want(name) || state.done.includes(name)) return;
      rows[name] = { what, ms: [] };
      try {
        await fn(rows[name].ms, rows[name]);
      } catch (e) {
        rows[name].error = String(e.message ?? e).split('\n')[0];
        await shot(`${name}-error`);
      }
      if (rows[name].reload) return true; // settings-cold: the page reloads and the row goes on there
      send({ row: name, ...rows[name] });
      state.done.push(name);
      save();
      log(`${name}: ${rows[name].error ?? `${rows[name].ms.length} repeats`}`);
      return false;
    };

    await connected();
    if (!state.started) {
      state.started = true;
      save();
      await press(treeRow(T['shop-t0']));
      await until(termDrawn(T['shop-t0'], 'shop-t0'));
      await shot('start');
    }

    await row('open-terminal', 'press on a tree row of a terminal session of another project whose tab is closed, until its tab shows the xterm rows with the session\'s last line', async (ms) => {
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
    await row('open-long-chat-cold', `press on the tree row of the ${job.long_events}-event chat whose tab is closed, until its chat list is loaded (aria-busy false) with rows on screen`, async (ms) => {
      for (let i = 0; i < job.repeats; i++) {
        await closeFromTree(C.history, chatDrawn(C.history));
        ms.push(await timed(chatDrawn(C.history), () => press(treeRow(C.history))));
        await settle();
      }
    });

    // The shop strip for the switch rows: a terminal, a short chat and the long chat open.
    const strip = async () => {
      for (const [id, cond] of [[C['chat-a'], chatDrawn(C['chat-a'])], [C.history, chatDrawn(C.history)], [T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0')]]) {
        await press(first(tab(id)) ? tab(id) : treeRow(id));
        await until(cond, 30000);
        await settle();
      }
    };
    if (!state.done.includes('switch-chat-to-long-chat')) await strip();
    const pair = (a, condA, b, condB) => async (ms, back) => {
      for (let i = 0; i < job.repeats; i++) {
        await show(a, condA);
        ms.push(await timed(condB, () => press(tab(b))));
        await settle();
        if (back) back.push(await timed(condA, () => press(tab(a))));
        await settle();
      }
    };
    const backRow = { what: 'press on the tab of an open terminal (a chat tab active), until its xterm rows show the session\'s last line', ms: [] };
    await row('switch-terminal-to-chat', 'press on the tab of an open chat (a terminal tab active), until the chat list shows its rows', async (ms) => {
      await pair(T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0'), C['chat-a'], chatDrawn(C['chat-a']))(ms, backRow.ms);
    });
    if (backRow.ms.length && !state.done.includes('switch-chat-to-terminal')) {
      send({ row: 'switch-chat-to-terminal', ...backRow });
      state.done.push('switch-chat-to-terminal');
      save();
    }
    await row('switch-chat-to-long-chat', `press on the tab of the open ${job.long_events}-event chat (a short chat active), until its chat list shows its rows`, (ms) => pair(C['chat-a'], chatDrawn(C['chat-a']), C.history, chatDrawn(C.history))(ms));

    const gear = 'nav[aria-label="Left bar"] button[aria-label="Settings"]';
    const settingsDrawn = { sel: '[role="dialog"] .settings .spage h1' };
    const closeSettings = async () => {
      const b = byName('Close Settings');
      if (b) await press(b); else key('Escape');
      await gone('.settings');
      await settle();
    };
    // Each repeat: the page reloads (the row's earlier presses are kept in sessionStorage), then one press.
    const reloading = await row('settings-cold', 'press on the Left bar Settings button, first time in the page\'s life (a reload before each), until the Settings page heading shows', async (ms, r) => {
      if (state.coldReloaded) {
        await until({ sel: '.tab[aria-selected="true"]' }, 30000); // the reload restores the last active tab
        await sleep(1000);
        state.cold.push(await timed(settingsDrawn, () => press(gear)));
        await closeSettings();
      }
      if (state.cold.length < job.repeats) {
        state.coldReloaded = true;
        save();
        r.reload = true;
        location.reload();
        return;
      }
      ms.push(...state.cold);
    });
    if (reloading) return;
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
        key('Escape');
        await gone('.board').catch(async () => { await press(boardBtn); await gone('.board'); });
        await settle();
      }
    });

    const chip = '.shead [data-team-chip]';
    const teamDrawn = { sel: '.teamv[data-where="side"] .lead-row[data-task]', min: 2 };
    const teamIcon = 'nav[data-bar="right"] [data-icon="team"] .ai';
    const teamOpen = async () => {
      await show(job.lead, { sel: chip });
      if (!first('.teamv')) { await press(chip); await until(teamDrawn); }
    };
    await row('team-open', 'press on the lead\'s "2 tasks" chip (the Team view closed), until the Team view at the side shows both task rows', async (ms) => {
      await show(job.lead, { sel: chip });
      if (first('.teamv')) { await press(teamIcon); await gone('.teamv'); }
      for (let i = 0; i < job.repeats; i++) {
        ms.push(await timed(teamDrawn, () => press(chip)));
        await settle();
        await press(teamIcon);
        await gone('.teamv');
        await settle();
      }
    });
    await row('team-room', 'press on the Team view\'s Room tab (Tasks shown), until the room\'s chat shows', async (ms) => {
      await teamOpen();
      for (let i = 0; i < job.repeats; i++) {
        ms.push(await timed({ sel: '.teamv[data-where="side"] .teamv-room .room-chat' }, () => press('#teamv-side-room-tab')));
        await settle();
        await press('#teamv-side-tasks-tab');
        await until(teamDrawn);
        await settle();
      }
    });
    // Look v9 Home S3-7: after pressing a lead's row the Team panel was blank for several seconds. The Team view is left
    // open at the side for shop; each repeat shows a terminal of another project first (no lead there), then presses the
    // lead's row in the tree.
    await row('lead-row-team', 'press on the lead\'s tree row (a terminal of another project shown, the Team view open at the side for the lead\'s place), until the Team view at the side shows both task rows', async (ms, r) => {
      await teamOpen();
      const other = otherTerms[0];
      const blank = [];
      for (let i = 0; i < job.repeats; i++) {
        await press(treeRow(T[other]));
        await until(termDrawn(T[other], other));
        await sleep(300);
        let saw = 0;
        const t = await timed(teamDrawn, async () => {
          await press(`.tree [data-menu-session="${job.lead}"]`);
          // What the side shows in the first frame after the press: a Team view without rows counts as blank.
          requestAnimationFrame(() => { saw = first('.teamv[data-where="side"]') ? (holds(teamDrawn) ? 2 : 1) : 0; });
        });
        ms.push(t);
        blank.push(saw);
        if (t >= 1000) { // what the side showed at the end of a slow press
          const side = first('.teamv[data-where="side"]');
          (r.slow ??= []).push({ i, ms: Math.round(t), side: side ? side.textContent.replace(/\s+/g, ' ').slice(0, 160) : null, active: first('.tab[aria-selected="true"]')?.dataset.tab === job.lead });
          if (r.slow.length <= 2) await shot(`lead-row-team-slow-${i}`);
          // Do the rows come at all? Up to 30 s more, then the time from the press (approximate: 50 ms polls, shot included).
          const t1 = performance.now();
          const came = await until(teamDrawn, 30000).then(() => true, () => false);
          r.slow.at(-1).rowsAfterS = came ? Math.round((t + performance.now() - t1) / 100) / 10 : null;
        }
        await settle();
      }
      r.firstFrame = { noTeamView: blank.filter((x) => x === 0).length, teamViewWithoutRows: blank.filter((x) => x === 1).length, rows: blank.filter((x) => x === 2).length };
    });

    await row('scroll-long-chat', 'scrollTop of the long chat (Verbose view) moved up 120 px every 16 ms for 3 s, from its end, 3 runs (a synthetic wheel event does not scroll): every animation frame\'s interval (ms)', async (ms, r) => {
      r.frames = true;
      const runs = Math.max(1, Math.round(job.repeats / 10));
      r.repeats = runs;
      r.rows = [];
      for (let k = 0; k < runs; k++) {
        await show(C.history, chatDrawn(C.history));
        const cyc = `.chat[data-session="${C.history}"] .cview button`;
        for (let i = 0; i < 4 && !/Verbose/.test(first(cyc)?.getAttribute('aria-label') ?? ''); i++) { await press(cyc); await sleep(200); }
        await until(chatDrawn(C.history));
        const list = first(`.chat[data-session="${C.history}"] .cscroll`);
        list.scrollTop = list.scrollHeight;
        await settle();
        const frames = [], keys = new Set();
        let on = true;
        const f = (t) => { if (!on) return; frames.push(t); for (const e of document.querySelectorAll('.chat:not([aria-hidden="true"]) .crow')) keys.add(e.dataset.key); requestAnimationFrame(f); };
        requestAnimationFrame(f);
        const end = performance.now() + 3000;
        const box = list.getBoundingClientRect();
        while (performance.now() < end) {
          list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
          list.scrollTop -= 120;
          await sleep(16);
        }
        on = false;
        r.rows.push(keys.size);
        for (let i = 1; i < frames.length; i++) ms.push(frames[i] - frames[i - 1]);
      }
    });

    // Composer: keydown to the end of the first frame whose textarea holds the typed text.
    const typing = (open) => async (ms) => {
      await open();
      await press('textarea#composer');
      await sleep(200);
      const box = first('textarea#composer');
      box.focus();
      const keys = [...job.keys];
      for (let i = 0; i < job.composer_n; i++) {
        const k = keys[i % keys.length];
        const want = box.value + k;
        ms.push(await timed({ sel: 'textarea#composer', value: want }, () => key(k, box)));
        if (i % 40 === 39) { box.select(); document.execCommand('delete'); }
        await sleep(50);
      }
      box.select();
      document.execCommand('delete');
    };
    await row('composer-keystroke', 'keydown in chat-a\'s composer to the end of the first frame whose textarea holds the new text (insertText after the keydown)', typing(async () => { await press(first(tab(C['chat-a'])) ? tab(C['chat-a']) : treeRow(C['chat-a'])); await until(chatDrawn(C['chat-a']), 30000); }));
    await row('composer-keystroke-long-chat', `the same keystroke in the composer of the open ${job.long_events}-event chat (its tab active)`, typing(async () => { await press(first(tab(C.history)) ? tab(C.history) : treeRow(C.history)); await until(chatDrawn(C.history), 30000); }));

    // B17 slow list (limit 1 s each).
    const icon = (w) => `.ib.r .aiw[data-icon="${w}"] button`;
    const toggleRow = (w, cond, closeSel) => async (ms) => {
      await show(T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0'));
      if (first(closeSel)) { await press(icon(w)); await gone(closeSel); }
      for (let i = 0; i < job.repeats; i++) {
        ms.push(await timed(cond, () => press(icon(w))));
        await settle();
        await press(icon(w));
        await gone(closeSel);
        await settle();
      }
    };
    await row('diff-open', 'press on the right bar\'s Diff button (a shop terminal shown, one changed file), until the Diff pane lists the changed file', toggleRow('diff', { sel: '.diff .dfiles [data-path]' }, '.diff'));
    await row('decisions-open', 'press on the right bar\'s Decisions button, until the Decisions widget body shows', toggleRow('decisions', { sel: '[data-widget-body="decisions"]' }, '[data-widget-body="decisions"]'));
    await row('side-chat-open', 'press on the chat head\'s "Side chat" button (chat-a shown), until the side chat split shows its head; the split is closed after each', async (ms) => {
      await show(C['chat-a'], chatDrawn(C['chat-a']));
      for (let i = 0; i < job.repeats; i++) {
        const b = byName('Side chat', '.shead');
        if (!b) throw new Error('no Side chat button in the chat head');
        ms.push(await timed({ sel: '[data-split-id] [data-side-chat]' }, () => press(b)));
        await settle();
        const split = first('[data-split-id] [data-side-chat]')?.closest('[data-split-id]');
        const x = split && byName('Close split', `[data-split-id="${split.dataset.splitId}"]`);
        if (x) await press(x);
        await gone('[data-split-id] [data-side-chat]');
        await settle();
      }
    });
    const card = () => [...document.querySelectorAll('.board .wcard, .board .bcard')].find((e) => rendered(e) && e.textContent.includes(job.card_title)) ?? null;
    const openBoard = async () => { if (!first('.board')) { await press(boardBtn); await until({ sel: '.board [data-menu-session]' }); await settle(); } };
    const closeCard = async () => {
      if (first('.bedit')) { key('Escape', first('.bedit input')); await gone('.bedit'); }
      if (first('.wdetail')) { await press([...document.querySelectorAll('.wdetail .wdh .wdx')].pop()); await gone('.wdetail'); } // the last is Close
      await settle();
    };
    await row('card-open', 'press on a manual card on the Board, until its detail (or its editor) shows', async (ms) => {
      await show(T['shop-t0'], termDrawn(T['shop-t0'], 'shop-t0'));
      await openBoard();
      for (let i = 0; i < job.repeats; i++) {
        const c = card();
        if (!c) throw new Error(`no card "${job.card_title}" on the Board`);
        ms.push(await timed({ sel: '.wdetail, .bedit' }, () => press(c)));
        await settle();
        await closeCard();
      }
    });
    await row('card-save', 'press on Save in a manual card\'s editor with a changed title, until the editor is gone and the card shows the new title', async (ms) => {
      await openBoard();
      for (let i = 0; i < job.repeats; i++) {
        await press(card());
        await until({ sel: '.wdetail, .bedit' });
        if (!first('.bedit')) await press([...document.querySelectorAll('.wdetail .bdbtn')].filter(rendered).pop()); // the last: "Edit card" (the first starts a session)
        await until({ sel: '.bedit input' });
        const input = first('.bedit input');
        input.focus();
        input.select();
        const title = `${job.card_title} ${i}`;
        document.execCommand('insertText', false, title);
        await sleep(100);
        ms.push(await timed({ sel: '.board .wcard, .board .bcard', text: title, gone: '.bedit' }, () => press('.bedit button.btn.p'))); // Save
        await settle();
        await closeCard();
      }
    });

    await shot('end');
    send({ done: true });
  };
  run().catch(async (e) => {
    try {
      const tree = document.querySelector('.tree');
      send({ fatal: String(e.message ?? e), size: [innerWidth, innerHeight], tree: !!tree, rows: document.querySelectorAll('.tree .row').length, wt2: document.querySelectorAll('.tree .row.wt2').length, menu: [...document.querySelectorAll('[data-menu-session]')].slice(0, 5).map((x) => `${x.tagName}.${x.className}`) });
    } catch { /* no sink */ }
  });
})();
