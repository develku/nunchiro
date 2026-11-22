// v25-quiet-chat (tickets 282 items 3-4, 284 item 3, 294 item 2; needs 205, 207, 213): the chat holds no resume or exit
// strip and no decision line, the skip note keeps off the mode button, and a first message typed while the agent still
// asks its startup questions waits for the answer instead of going into the dialog.
import type { Page } from '@playwright/test';
import { append, chat, expect, openChat, rec, test } from './fixtures/chat/harness';

const sessionOf = (core: { cli: (...a: string[]) => any }, id: string) => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id);

/** Proxies the window's socket: `pend(id)` is the dialog the snapshot shows for that session (null = none). Requests are
 *  recorded. `refresh()` re-sends the last snapshot with the current pending list, as the core does when state changes. */
async function proxy(page: Page, sessionId: string, kind: 'dialog' | 'permission', text: string, completionSeq = 0) {
  const state = { on: true, working: false, starting: false, refuse: '', sent: [] as { op: string; [k: string]: unknown }[], last: null as string | null, socks: new Set<(raw: string) => void>() };
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? [])
      if (s.id === sessionId) {
        s.completion_seq = completionSeq; // turns the agent has completed: 0 until the first one ends
        s.starting = state.starting; // look 11-17 v3 P1: the core's "input box not shown yet"
        s.pending = state.on ? [{ id: `d-${sessionId}`, session_id: s.id, scope: s.project, kind, text, choices: [], observed_at: Date.now() - 5_000, actionable: true, risky: false }] : [];
        if (state.on) Object.assign(s.attention, { working: true, waiting: true, stale: false, failed: false });
        else if (state.working) Object.assign(s.attention, { working: true, waiting: false, stale: false, failed: false }); // the agent works on after its dialog
      }
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let sock: ((raw: string) => void) | null = null;
    ws.onClose(() => sock && state.socks.delete(sock));
    ws.onMessage((msg) => {
      const m = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (m?.request) state.sent.push(m.request);
      // `refuse`: the core's answer to every send_text while it is set (a gate refusal written before any byte).
      if (m?.request?.op === 'send_text' && state.refuse) return void ws.send(JSON.stringify({ id: m.id, response: { Err: state.refuse } }));
      server.send(msg);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      state.last = raw;
      // The sockets that carry snapshots (the chat feed has its own); the window may reconnect, so every live one is kept.
      if (!sock) state.socks.add((sock = (r: string) => ws.send(patch(r))));
      ws.send(patch(raw));
    });
  });
  return { state, refresh: () => state.last && state.socks.forEach((send) => send(state.last!)) };
}

test('chat_has_no_resume_or_exit_strips: an ended agent shows no "is closed + Resume" row', async ({ page, chatCore }) => {
  const s = chatCore.chat();
  append(s.file, rec.user('before closing'), rec.assistant('the answer'));
  chatCore.cli('session', 'close', s.id);
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  // Reached from the palette (a closed session opens no tab of its own), as closed-session-readonly does.
  await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog', { name: 'Command palette' }).locator(`[data-command="session.open.${s.id}"]`).click();
  await expect(chat(page, s.id).getByText('the answer')).toBeVisible();
  await expect.poll(() => sessionOf(chatCore, s.id)?.state).toBe('closed');
  await expect(page.locator('.resume')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resume / })).toHaveCount(0);
  await expect(page.getByText(/ is (closed|exited)\.$/)).toHaveCount(0);
});

test('chat_has_no_resume_strip_after_restart: sessions the core can resume are not offered in a bar over the chat', async ({ page, chatCore }) => {
  const s = chatCore.chat('alpha');
  chatCore.cli('serve', 'stop');
  await chatCore.restart();
  await page.addInitScript((boot) => (window.__NUNCHIRO__ = boot), chatCore.boot());
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  expect(sessionOf(chatCore, s.id)?.state).toBe('resumable');
  await expect(page.getByRole('region', { name: 'Sessions to resume' })).toHaveCount(0);
  await expect(page.getByText('Resume where you left off')).toHaveCount(0);
  await expect(page.locator('.resume')).toHaveCount(0);
});

test('chat_shows_no_decision_line: a waiting session shows neither the decision line nor "Waiting for you" in its chat', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(page.locator(`.tree [data-item="d-${s.id}"]`)).toBeVisible(); // the decision exists: the tree shows it
  await expect(view.locator('.dline')).toHaveCount(0);
  await expect(view.getByText('Waiting for you')).toHaveCount(0);
  await expect(view.getByRole('button', { name: 'Answer in Decisions' })).toHaveCount(0);
  await expect(view.getByText('Do you trust the files')).toHaveCount(0);
  await expect(view.locator('.wlive')).not.toContainText('Working'); // the timer row stays off while a decision waits
});

// Ticket 1030: a permission request of the session in front is answered on the card above its composer and Decisions no
// longer lists it; a background session's still goes to Decisions (both below). The tree keeps its mark either way.
test('decision_still_reaches_widget_and_tree_mark: the pending decision stays in the Decisions widget and on the tree row', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  const other = chatCore.chat('other', true, false, 'asks'); // one project, so the two tabs share a strip (ticket 570)
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await proxy(page, s.id, 'permission', 'Bash: pnpm install');
  await openChat(page, s.id);
  await expect(page.locator(`.tree [data-item="d-${s.id}"]`)).toBeVisible();
  await expect(page.locator('.shead .st')).toHaveAttribute('data-s', /wait|ask|need|attention/i);
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click();
  const widget = page.locator('.wg[data-widget="decisions"], .sbar[data-widget="decisions"]').first();
  await expect(page.locator(`.composer .deccard.docked[data-session="${s.id}"]`)).toContainText('pnpm install'); // in front: above its composer
  await expect(widget).toContainText('Nothing waiting');
  await page.locator(`.tab[data-tab="${other.id}"]`).click(); // in the background: in Decisions, the tree mark stays
  await expect(widget).toContainText('pnpm install');
  await expect(page.locator(`.tree [data-item="d-${s.id}"]`)).toBeVisible();
});

test('decisions_widget_within_two_clicks: from a waiting session, one tab click and one Decisions click reach the widget', async ({ page, chatCore }) => {
  const s = chatCore.chat('asks');
  append(s.file, rec.user('go'), rec.assistant('Let me ask.'));
  await proxy(page, s.id, 'permission', 'Bash: pnpm install');
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await page.locator(`.tab[data-tab="${s.id}"]`).click(); // click 1: the waiting session
  // Ticket 1030: its request is above its composer after that one click; Decisions (click 2) lists the other sessions' requests.
  await expect(page.locator(`.composer .deccard.docked[data-session="${s.id}"]`)).toContainText('pnpm install');
  await page.getByRole('navigation', { name: 'Right bar' }).getByRole('button', { name: 'Decisions' }).click(); // click 2
  await expect(page.locator('.wg[data-widget="decisions"], .sbar[data-widget="decisions"]').first()).toBeVisible();
});

for (const width of [900, 1440]) {
  test(`transcript_skip_note_does_not_overlap_mode_button (${width}px)`, async ({ page, chatCore }) => {
    await page.setViewportSize({ width, height: 800 });
    const s = chatCore.chat();
    append(s.file, rec.assistant('before'), '{"type":"nope"}', 'garbage line');
    await openChat(page, s.id);
    const view = chat(page, s.id);
    const note = view.locator('.skipped');
    const mode = view.getByRole('button', { name: /^Transcript view/ });
    await expect(note).toHaveText('Some lines could not be shown');
    const a = (await note.boundingBox())!;
    const b = (await mode.boundingBox())!;
    const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(apart, `note ${JSON.stringify(a)} vs button ${JSON.stringify(b)}`).toBe(true);
  });
}

test('first_message_survives_startup_prompt: a message sent while a startup dialog waits is held, then delivered once it is answered', async ({ page, chatCore }) => {
  const s = chatCore.chat('first', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('hello agent');
  await page.locator('.composer .send').click();
  // Held: nothing reached the agent (the dialog would have taken it), the words are shown as waiting.
  const held = page.locator('.composer .held');
  await expect(held).toContainText('hello agent');
  await page.waitForTimeout(600);
  expect(p.state.sent.filter((r) => r.op === 'send_text' || r.op === 'send_keys')).toHaveLength(0);
  // The dialog is answered (the snapshot no longer lists it): the held message goes in once, then Enter.
  p.state.on = false;
  p.refresh();
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_text').length).toBe(1);
  expect(p.state.sent.find((r) => r.op === 'send_text')).toMatchObject({ id: s.id, composer: true });
  expect(String(p.state.sent.find((r) => r.op === 'send_text')!.text)).toContain('hello agent');
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_keys').length).toBe(1);
  await expect(held).toHaveCount(0);
  await p.refresh();
  await page.waitForTimeout(300);
  expect(p.state.sent.filter((r) => r.op === 'send_text')).toHaveLength(1); // never twice
});

test('long_held_message_keeps_terminal_rows: a held lead brief stays a short box and the start question keeps a full terminal', async ({ page, chatCore }) => {
  // Look 1117 v16/b2 (w25-l): the composer grew to the window's height around a held brief, the auto-opened PTY beside it fell to 4
  // rows, and Claude cut off its "Adding a new directory" question there and refused Yes: the lead never started.
  const s = chatCore.chat('lead', false);
  await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const brief = Array.from({ length: 80 }, (_, i) => `Rule ${i}: keep the work small and report back.`).join(' ');
  await page.locator('.composer textarea').fill(brief);
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('Rule 79');
  expect((await held.boundingBox())!.height).toBeLessThan(160);
  const rows = page.locator(`[data-side-pane] .term[data-session="${s.id}"] .xterm-rows > div`);
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(30);
  await held.getByRole('button', { name: 'Cancel send' }).click(); // still reachable inside the capped box
  await expect(held).toHaveCount(0);
});

test('quiet_chat_basic_interactions: the held message has a named Cancel that gives the words back and returns focus', async ({ page, chatCore }) => {
  const s = chatCore.chat('basics', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('keep these words');
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('keep these words');
  const cancel = held.getByRole('button', { name: 'Cancel send' });
  await cancel.hover();
  await expect(page.locator('#app-tip')).toContainText('Cancel send');
  await cancel.click();
  await expect(held).toHaveCount(0);
  await expect(box).toHaveValue('keep these words');
  await expect(box).toBeFocused();
  // Esc in the chat's composer with a held message cancels it too (the box is where the words come back).
  await page.locator('.composer .send').click();
  await expect(held).toContainText('keep these words');
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(held).toHaveCount(0);
  await expect(box).toHaveValue('keep these words');
  expect(p.state.sent.filter((r) => r.op === 'send_text')).toHaveLength(0);
});

test('hold_only_for_startup_prompts: a permission wait after the session has completed turns is not held (the startup case is first_message_survives_startup_prompt)', async ({ page, chatCore }) => {
  // A session that has finished turns (completion_seq 2) and now waits on a permission: the message goes the way it did before
  // the hold (ticket 123's gate decides), it is not parked behind the wait.
  const late = chatCore.chat('late');
  append(late.file, rec.user('go'), rec.assistant('Let me run it.'));
  const p = await proxy(page, late.id, 'permission', 'Bash: pnpm install', 2);
  await openChat(page, late.id);
  await page.locator('.composer textarea').fill('hello again');
  await page.locator('.composer .send').click();
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_text').length).toBe(1);
  await expect(page.locator('.composer .held')).toHaveCount(0);
});

test('second_send_while_held_says_why: a second message while one is held stays in the box and the composer says why', async ({ page, chatCore }) => {
  const s = chatCore.chat('twice', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('one');
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('one');
  await expect(page.locator('.composer .held-why')).toHaveCount(0);
  await box.fill('two');
  await page.locator('.composer .send').click();
  await expect(page.locator('.composer .held-why')).toHaveText('One message is already waiting; yours stays in the box.');
  await expect(box).toHaveValue('two'); // not dropped
  await expect(held).toContainText('one'); // the first is untouched
  expect(p.state.sent.filter((r) => r.op === 'send_text' || r.op === 'send_keys')).toHaveLength(0);
  // The note goes when the held message does (Esc in the box gives 'one' back, before 'two').
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(held).toHaveCount(0);
  await expect(page.locator('.composer .held-why')).toHaveCount(0);
});

test('quiet_chat_should_4: while a message is held the composer offers no Stop, so Esc only gives the words back and sends no key', async ({ page, chatCore }) => {
  // Review SHOULD 4 feared that Esc, spent on the held message, could never interrupt a working agent. A held message means a dialog is
  // pending, and a session with a pending dialog reads "waiting", never "working" (types.ts status), so there is nothing to stop:
  // the first Esc is the only Esc the composer has to answer, and it must not leak a key into the dialog.
  const s = chatCore.chat('stop-held', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('hold then escape');
  await page.locator('.composer .send').click();
  await expect(page.locator('.composer .held')).toContainText('hold then escape');
  await expect(page.locator('.composer .send')).not.toHaveAccessibleName('Stop');
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.composer .held')).toHaveCount(0);
  await expect(box).toHaveValue('hold then escape');
  await page.keyboard.press('Escape'); // the dialog is still asked: still nothing to stop
  await page.waitForTimeout(400);
  expect(p.state.sent.filter((r) => r.op === 'send_text' || r.op === 'send_keys')).toHaveLength(0);
});

const escKeys = (p: { state: { sent: { op: string; [k: string]: unknown }[] } }) => p.state.sent.filter((r) => r.op === 'send_keys' && JSON.stringify(r.keys) === '["esc"]');

// V2.5-82 (review SHOULD 4 of v25-quiet-chat): Esc stops the working agent (CHAT-STOP). A held message always has a dialog
// pending, which reads "waiting" (Esc would answer the dialog), so the first Esc only gives the words back; once nothing is
// held and the agent works, the next Esc stops it, once.
test('held_esc_gives_back_then_stops: the first Esc gives a held message back and sends no stop; the second, with the agent working, stops it once', async ({ page, chatCore }) => {
  const s = chatCore.chat('escs', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('first words');
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('first words');
  await box.focus();
  await page.keyboard.press('Escape');
  await expect(held).toHaveCount(0);
  await expect(box).toHaveValue('first words');
  await page.waitForTimeout(300);
  expect(escKeys(p)).toHaveLength(0); // the dialog is still open: this Esc was the box's, not a stop
  // The dialog is answered and the agent works on: the Stop button shows, and the next Esc stops it, once.
  p.state.on = false;
  p.state.working = true;
  p.refresh();
  await expect(page.locator('.composer .send')).toHaveAccessibleName('Stop');
  await box.focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => escKeys(p).length).toBe(1);
  await page.waitForTimeout(300);
  expect(escKeys(p)).toHaveLength(1);
  expect(p.state.sent.filter((r) => r.op === 'send_text')).toHaveLength(0); // the words never went to the agent
});

test('held_esc_ime_and_repeat_unchanged: an IME composing Esc gives nothing back and stops nothing; a repeated Esc never stops', async ({ page, chatCore }) => {
  const s = chatCore.chat('escime', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('keep me');
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('keep me');
  // An IME's Esc (isComposing, or keyCode 229) is the IME's own: the message stays held.
  await box.focus();
  await box.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await expect(held).toContainText('keep me');
  expect(escKeys(p)).toHaveLength(0);
  // Words back, dialog answered, agent working: an IME Esc or a repeated Esc still stops nothing; a plain Esc does.
  await page.keyboard.press('Escape');
  await expect(held).toHaveCount(0);
  p.state.on = false;
  p.state.working = true;
  p.refresh();
  await expect(page.locator('.composer .send')).toHaveAccessibleName('Stop');
  await box.focus();
  await box.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  expect(escKeys(p)).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => escKeys(p).length).toBe(1);
});

// A9 (ticket 991, look 1117): while the agent asks its startup question in the terminal, the composer says a send waits for
// that answer, and the tree row offers no bare red X: for Claude's folder trust its one answer is "No, exit".
test('startup_prompt_composer_says_send_waits_and_row_has_no_bare_deny (A9)', async ({ page, chatCore }) => {
  const s = chatCore.chat('first', false);
  await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  // Ticket 1030: the question is on the card above the composer, and the placeholder says how to reach it.
  await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Answer its question first. A message you send now waits until you answer. Shift+Tab: to the card.');
  const line = page.locator(`.tree [data-item="d-${s.id}"]`);
  await expect(line).toBeVisible();
  await expect(line.locator('[data-act="details"]')).toBeVisible();
  await expect(line.locator('[data-act="deny"]')).toHaveCount(0);
});

// Look 11-17 v3 P1 (S1): between Claude's startup questions nothing is pending for a moment, and text typed then (before
// Claude's input box) was lost or left unsubmitted. A held message waits until the core says the start is over.
test('p1_held_message_waits_for_the_input_box_not_only_for_no_pending', async ({ page, chatCore }) => {
  const s = chatCore.chat('p1', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  p.state.starting = true;
  await openChat(page, s.id);
  await page.locator('.composer textarea').fill('hello agent');
  await page.locator('.composer .send').click();
  await expect(page.locator('.composer .held')).toContainText('hello agent');
  // The trust question is answered, but Claude has not drawn its input box yet: still held.
  p.state.on = false;
  p.refresh();
  await page.waitForTimeout(600);
  expect(p.state.sent.filter((r) => r.op === 'send_text' || r.op === 'send_keys')).toHaveLength(0);
  // The input box is up: the message goes in once, then Enter.
  p.state.starting = false;
  p.refresh();
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_text').length).toBe(1);
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_keys').length).toBe(1);
});

test('held_message_refused_by_the_gate_waits_again (look 1117 v13 N3)', async ({ page, chatCore }) => {
  const s = chatCore.chat('n3', false);
  const p = await proxy(page, s.id, 'dialog', 'Do you trust the files in this folder?');
  await openChat(page, s.id);
  const box = page.locator('.composer textarea');
  await box.fill('hello agent');
  await page.locator('.composer .send').click();
  const held = page.locator('.composer .held');
  await expect(held).toContainText('hello agent');
  // A startup redraw: the question leaves one snapshot, the release meets the core's gate, the words wait again.
  p.state.refuse = 'screen not current, try again';
  p.state.on = false;
  p.refresh();
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_text').length).toBeGreaterThan(0);
  await expect(held).toContainText('hello agent');
  await expect(box).toHaveValue('');
  // The gate lets it through on a later snapshot: it goes in, then Enter once, and the box stays empty.
  p.state.refuse = '';
  p.refresh();
  await expect.poll(() => p.state.sent.filter((r) => r.op === 'send_keys').length).toBe(1);
  await expect(held).toHaveCount(0);
  await expect(box).toHaveValue('');
});

// N27 (look 1117 v3): a Stop pressed before any output leaves no record in Claude's transcript; the chat still marks the
// message the user stopped as interrupted once the turn has ended.
test('stop_before_output_marks_interrupted (N27)', async ({ page, chatCore }) => {
  const s = chatCore.chat('stopper');
  append(s.file, rec.user('a long job'));
  let working = true;
  const socks = new Set<(raw: string) => void>();
  let last = '';
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const x of msg.sessions ?? []) if (x.id === s.id) Object.assign(x.attention, { working, waiting: false });
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'send_keys') return ws.send(JSON.stringify({ id: f.id, response: { Ok: 'Ack' } }));
      server.send(m);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      last = raw;
      socks.add((r) => ws.send(patch(r)));
      ws.send(patch(raw));
    });
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('a long job')).toBeVisible();
  await page.locator('.composer .send.stop').click();
  working = false;
  socks.forEach((send) => send(last));
  await expect(view.locator('.turnx')).toHaveText('Interrupted');
  // v9-B-N2-S3-1: as in Claude Code, the stopped message comes back to the composer to be edited, once.
  const box = page.locator('#composer');
  await expect(box).toHaveValue('a long job');
  await box.fill('');
  socks.forEach((send) => send(last));
  await page.waitForTimeout(300);
  await expect(box).toHaveValue('');
});

// v9-B-N2-S3-1: a draft typed while the turn ran is the owner's: the stopped message never replaces it.
test('stop_before_output_keeps_a_new_draft', async ({ page, chatCore }) => {
  const s = chatCore.chat('stopper2');
  append(s.file, rec.user('a long job'));
  let working = true;
  const socks = new Set<(raw: string) => void>();
  let last = '';
  const patch = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const x of msg.sessions ?? []) if (x.id === s.id) Object.assign(x.attention, { working, waiting: false });
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const f = typeof m === 'string' ? JSON.parse(m) : null;
      if (f?.request?.op === 'send_keys') return ws.send(JSON.stringify({ id: f.id, response: { Ok: 'Ack' } }));
      server.send(m);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      last = raw;
      socks.add((r) => ws.send(patch(r)));
      ws.send(patch(raw));
    });
  });
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('a long job')).toBeVisible();
  const box = page.locator('#composer');
  await box.fill('my next idea');
  await page.locator('.composer .send.stop').click();
  working = false;
  socks.forEach((send) => send(last));
  await expect(view.locator('.turnx')).toHaveText('Interrupted');
  await page.waitForTimeout(300);
  await expect(box).toHaveValue('my next idea');
});
