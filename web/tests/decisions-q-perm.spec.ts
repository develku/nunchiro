// Ticket 991 (B3, B4, B5, B7, B13): answering what a real Claude 2.1.325 asks, from the chat's diff card and the Decisions card. A fake Claude draws the agent's own
// frames (copied from a real 2.1.325 session: a banner and a blinking tool row above a full-width rule, file context
// around an edit, a note line above a Bash question) and asks through the real PermissionRequest hook, as Claude does.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { append, chat, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { REPO } from './fixtures';
import { icon, sidebar } from './d5b';

const BIN = path.join(REPO, 'target/debug/nunchiro');
const RULE = '─'.repeat(60);
// "HOOK <payload>" asks through the hook (and notes its return in hook-returned); "DRAW <frame>" draws frames/<frame>. Any other line is
// printed as answered (Esc as denied), so a typed answer shows on its screen.
const FAKE = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then cat '${home}/fake-version'; exit; fi
# A read times out every 0.3 s so a resize's WINCH redraws the frame, as Claude does (a trap waits for dd to return).
stty -icanon -echo -icrnl min 0 time 3 2>/dev/null
printf 'fake agent\\r\\n'
esc=$(printf '\\033'); cr=$(printf '\\r'); line=''
last=''
draw() { last="$1"; cat '${home}'/frame-"$1"; }
trap '[ -n "$last" ] && draw "$last"' WINCH
ask() { printf '%s' "$1" | '${BIN}' hook PermissionRequest > /dev/null 2>&1; echo returned >> '${home}/hook-returned'; }
while :; do
  c=$(dd bs=1 count=1 2>/dev/null)
  [ -z "$c" ] && continue
  # Denied: Claude's input box comes back, where a queued message is typed.
  if [ "$c" = "$esc" ]; then last=''; printf '\\033[2J\\033[Hdenied\\r\\n%s\\r\\n\\342\\235\\257 \\r\\n' '${RULE}'; line=''; continue; fi
  if [ -n "$c" ] && [ "$c" != "$cr" ]; then line="$line$c"; continue; fi
  case "$line" in
    HOOK\\ *) ask "\${line#HOOK }" & ;;
    DRAW\\ *) draw "\${line#DRAW }" ;;
    '') ;;
    *) last=''; printf '\\033[2J\\033[Hanswered %s\\r\\n' "$line" ;;
  esac
  line=''
done
`;
const DASH = '╌'.repeat(60);
const HEAD = ` ▐▛███▛█   Claude Code v2.1.325\n\n❯ do the thing\n\n⏺ Working\n${RULE}\n`;
const FRAMES: Record<string, string> = {
  edit: `${HEAD} Edit file\n a.txt\n${DASH}\n  1  first\n  2 -old\n  2 +new\n  3 +more\n  4  last\n${DASH}\n Do you want to make this edit to a.txt?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits\n      and common file commands) for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n`,
  bash: `${HEAD} Bash command\n List files\n${DASH}\n ls -la\n${DASH}\n This command requires approval\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don’t ask again for: ls *\n   3. No\n\n Esc to cancel · Tab to amend\n`,
  // A narrow terminal wraps the diff: the core cannot match it to a request, so it is a screen-only (risky) card.
  narrow: `${HEAD} Edit file\n app.py\n${DASH}\n  7      raise ValueError(f'percent must be\n     0..100, got {percent}')\n  8 +def tax(rate):\n${DASH}\n Do you want to make this edit to app.py?\n ❯ 1. Yes\n   2. Yes, and switch to accept edits (auto-approve file edits\n      and common file commands) for this session (shift+tab)\n   3. No\n\n Esc to cancel · Tab to amend\n`,
  trust: `  Folder access\n  /tmp/p\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run\n  code automatically. Continue only if you trust these files. Your trust decision will be saved.\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n`,
  // The same Bash prompt a second later: the tool row's ⏺ above the rule has blinked off.
  blink: '',
  question: `${HEAD} Which currency?\n ❯ 1. USD\n   2. EUR\n\n Enter to select · Esc to cancel\n`,
};

FRAMES.blink = FRAMES.bash.replace('⏺ Working', '  Working');
// A command that is no read (B6-S3-2).
FRAMES.touch = FRAMES.bash.replace('List files', 'Make the note').replace('ls -la', 'touch note.txt').replace('ls *', 'touch *');

class PermCore extends ChatCore {
  constructor(id: string) {
    super(id);
    fs.writeFileSync(path.join(this.home, 'bin/claude'), FAKE(this.home), { mode: 0o700 });
    // Each frame file starts with the clear, so a redraw is one write, as Claude's is. Cleared by a printf before the `cat`,
    // the screen was empty while `cat` started: on a loaded machine the core read it then, took the prompt for answered and
    // filed the redrawn one under a new id, screen only (B13 red 1 of 4 alone, both browsers; lane w69).
    for (const [name, text] of Object.entries(FRAMES)) fs.writeFileSync(path.join(this.home, `frame-${name}`), `\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`);
  }
  private asked = 0;
  /** A permission request as Claude makes it: the hook first, its prompt on the screen once the core holds the request.
   *  The fake used to draw at once, and on a loaded machine the frame reached the core before the hook did. For that
   *  moment the item was the screen's alone, so the chat opened its side terminal for it (47 columns), the 60-column
   *  frame wrapped in the redraw, and Allow was refused from then on ("decision screen changed"): B7 red 1 to 4 of 10. */
  async ask(id: string, frame: string, tool_name: string, tool_input: unknown) {
    this.asked += 1;
    this.cli('session', 'send-text', id, `HOOK ${JSON.stringify({ tool_name, tool_input })}\r`);
    // The fake reads its line a byte at a time (a `dd` each): on a loaded machine the request takes seconds to leave it.
    await expect.poll(() => this.pending().some((d) => d.session_id === id && d.sources.includes('hook')), { timeout: 20_000 }).toBe(true);
    this.draw(id, frame);
  }
  /** Every hook asked so far has returned: its 1.4 s lease is over, so an answer from here on is typed into the prompt
   *  on the screen (the fake shows it as "answered …"); inside the lease it would go back through the hook. */
  leaseOver() {
    const file = path.join(this.home, 'hook-returned');
    return expect.poll(() => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0), { timeout: 15_000 }).toBe(this.asked);
  }
  draw(id: string, frame: string) {
    this.cli('session', 'send-text', id, `DRAW ${frame}\r`);
  }
  pending(): { id: string; session_id: string; sources: string[]; kind: string; text: string; risky?: boolean }[] {
    return this.cli('snapshot', '--json').sessions.flatMap((s: { pending: unknown[] }) => s.pending);
  }
  screen(id: string): string {
    const out = this.cli('session', 'read', id) as { data: number[] };
    return Buffer.from(out.data).toString('utf8');
  }
}

const t = test.extend<{ pc: PermCore }>({
  pc: async ({ page }, use, info) => {
    const core = new PermCore(`qperm-${info.workerIndex}-${info.testId.slice(0, 8)}`);
    await core.ready();
    await page.addInitScript((boot) => {
      window.__NUNCHIRO__ = boot;
      const w = window as unknown as { __sent: { op: string }[] };
      w.__sent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          const f = typeof data === 'string' ? JSON.parse(data) : null;
          if (f?.request) w.__sent.push(f.request);
        } catch {
          // Not JSON.
        }
        return send.call(this, data);
      };
    }, core.boot());
    await use(core);
    await core.stop();
  },
});
const answers = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { op: string }[] }).__sent.filter((r) => r.op === 'answer'));
/** The session's card in the Decisions widget, once the item it shows is one the core holds now and has been for 600 ms
 *  (as `settled` in decisions-widget.spec.ts: opening the sidebar refits the terminal, and a redraw may re-file the
 *  prompt under a new id; a click between two steps answers an id the core has dropped). */
async function card(page: Page, pc: PermCore, id: string) {
  const bar = icon(page, 'right', 'Decisions');
  if ((await bar.getAttribute('aria-pressed')) !== 'true') await bar.click();
  // Ticket 1030: the chat in front answers an ordinary permission on its own card above the composer, not in Decisions.
  const listed = sidebar(page, 'right').locator(`.deccard[data-session="${id}"] .dc-item`);
  const docked = page.locator(`.composer .deccard.docked[data-session="${id}"] .dc-item`);
  await expect(listed.or(docked).first()).toBeVisible();
  const item = (await listed.count()) ? listed : docked;
  let last: string | null = null;
  let since = 0;
  await expect
    .poll(async () => {
      const shown = await item.getAttribute('data-item').catch(() => null);
      const held = pc.pending().some((d) => d.id === shown);
      if (!held || shown !== last) [last, since] = [held ? shown : null, Date.now()];
      return held && Date.now() - since >= 600;
    }, { intervals: [150] })
    .toBe(true);
  return item;
}

t('B3: Accept on a 2.1.325 edit (file context around it) works after the hook has returned: the item stays the hook request, not risky', async ({ page, pc }) => {
  const s = pc.chat('edit');
  const input = { file_path: path.join(s.cwd, 'a.txt'), old_string: 'old', new_string: 'new\nmore' };
  await openChat(page, s.id);
  append(s.file, rec.user('edit a.txt'), rec.use('e1', 'Edit', input));
  await pc.ask(s.id, 'edit', 'Edit', input);
  await expect.poll(() => pc.pending().map((d) => [d.kind, d.risky ?? true])).toEqual([['permission', false]]);
  await pc.leaseOver(); // the answer is typed into the verified prompt
  const accept = chat(page, s.id).locator('.dcard').getByRole('button', { name: 'Allow once' });
  await expect(accept).toBeVisible();
  await accept.click();
  await expect.poll(() => pc.screen(s.id)).toContain('answered 1');
  expect(pc.pending()).toEqual([]);
});

t('B7: a Bash permission reads as its command, not JSON, and Allow answers it', async ({ page, pc }) => {
  const s = pc.chat('cmd');
  await openChat(page, s.id);
  await pc.ask(s.id, 'bash', 'Bash', { command: 'ls -la', description: 'List files' });
  const item = await card(page, pc, s.id);
  await expect(item.locator('.dc-what')).toContainText('ls -la');
  await expect(item.locator('.dc-why')).toContainText('List files');
  await expect(item).not.toContainText('{"command"');
  await expect.poll(() => pc.pending().map((d) => d.risky ?? true)).toEqual([false]);
  await pc.leaseOver();
  await item.locator('[data-act="allow"]').click();
  await expect.poll(() => pc.screen(s.id)).toContain('answered 1');
});

t('B7: a question reads as its question and options, not JSON', async ({ page, pc }) => {
  const s = pc.chat('question');
  await openChat(page, s.id);
  await pc.ask(s.id, 'question', 'AskUserQuestion', { questions: [{ question: 'Which currency?', options: [{ label: 'USD', description: 'US dollar' }, { label: 'EUR' }] }] });
  const item = await card(page, pc, s.id);
  await expect(item.locator('.dc-what')).toContainText('Which currency?');
  // Sixth look (B6-S3-3): the line is the question itself; with the "What" label before it, it read "What alpha or beta?".
  await expect(item.locator('.dc-what')).toHaveText('Which currency?');
  await expect(item.locator('.dc-code')).toContainText('1. USD — US dollar');
  await expect(item.locator('.dc-code')).toContainText('2. EUR');
  await expect(item).not.toContainText('{"questions"');
});

t('B4: a screen-only edit card says "Edit app.py", shows the prompt (no banner), offers no code fragment, and draws no button that does nothing', async ({ page, pc }) => {
  const s = pc.chat('narrow');
  await openChat(page, s.id);
  pc.draw(s.id, 'narrow');
  const item = await card(page, pc, s.id);
  await expect(item.locator('.dc-what')).toContainText('Edit app.py');
  await expect(item.locator('.dc-why')).toContainText('could not match this prompt');
  await expect(item.locator('.dc-code')).toContainText('Do you want to make this edit to app.py?');
  await expect(item.locator('.dc-code')).not.toContainText('Claude Code v2.1.325');
  expect((await item.locator('.dc-btns button, .dc-opts .opt').allTextContents()).join('|')).not.toContain('.100');
  // Look v34: the settings-changing option is not listed (a text chip read as a button); every button does something.
  await expect(item.locator('.opt, [data-act="option"]')).toHaveCount(0);
  await expect(item.locator('.dc-btns')).not.toContainText('switch to accept edits');
  await expect(item.locator('button:disabled')).toHaveCount(0);
});

t('B5: a folder-trust prompt shows its question and no choice buttons; the terminal answers it, Esc is the one key sent', async ({ page, pc }) => {
  const s = pc.chat('trust');
  await openChat(page, s.id);
  pc.draw(s.id, 'trust');
  const item = await card(page, pc, s.id);
  await expect(item.locator('.dc-what')).toContainText('Trust this folder?');
  await expect(item.locator('[data-act="choose"], [data-act="option"], .dc-opts')).toHaveCount(0);
  await expect(item.locator('[data-act="terminal"]')).toBeVisible();
  // Opening the chat refits the terminal and the redraw re-files the prompt: answer the item the core holds now.
  await expect.poll(async () => pc.pending().map((d) => d.id).includes((await item.getAttribute('data-item')) ?? '')).toBe(true);
  await item.locator('[data-act="deny"]').click();
  await expect.poll(() => pc.screen(s.id)).toContain('denied');
});

// Sixth look (B6-S3-2): while a command's request waited (its card up, or Deny's note box open) the chat's line read
// "Ran 1 command". It has not run: the line says it waits, and reads "Ran" only once the command has its result.
t('B6-S3-2: the chat line of a command whose request waits says it waits, never "Ran"', async ({ page, pc }) => {
  const s = pc.chat('wait');
  const input = { command: 'touch note.txt', description: 'Make the note' };
  await openChat(page, s.id);
  append(s.file, rec.user('make the note'), rec.use('b1', 'Bash', input));
  await pc.ask(s.id, 'touch', 'Bash', input);
  await expect.poll(() => pc.pending().map((d) => d.kind)).toEqual(['permission']);
  const line = chat(page, s.id).locator('.turnsum .sum .n');
  await expect(line).toHaveText('1 command waiting for your answer');
  const item = await card(page, pc, s.id);
  await pc.leaseOver(); // the answer is typed into the prompt
  await item.locator('[data-act="allow"]').click();
  await expect.poll(() => pc.screen(s.id)).toContain('answered 1');
  append(s.file, rec.result('b1', 'ok'));
  await expect(line).toHaveText('Ran 1 command');
});

// Look v36 (S3-4): Claude's REPL runs Edit inside its script and Poll waits on it, so one Edit request left two calls with
// no result and the line said "2 requests waiting for your answer" above the one card.
t('v36-S3-4: one Edit request inside REPL and Poll reads "1 request waiting for your answer"', async ({ page, pc }) => {
  const s = pc.chat('repl');
  const input = { file_path: 'readme.txt', old_string: 'hello world\n', new_string: 'hello again\n' };
  await openChat(page, s.id);
  append(s.file, rec.user('change readme.txt'), rec.use('r1', 'REPL', { code: 'await tools.Edit({})' }), rec.use('p1', 'Poll', {}));
  await pc.ask(s.id, 'edit', 'Edit', input);
  await expect.poll(() => pc.pending().map((d) => d.kind)).toEqual(['permission']);
  await expect(chat(page, s.id).locator('.turnsum .sum .n')).toHaveText('1 request waiting for your answer');
});

t('B13: the instruction typed with a deny reaches the agent', async ({ page, pc }) => {
  const s = pc.chat('note');
  // Ticket 1030 (look v34 S3-4): the card above the composer has no field, its Deny answers at once; the session is
  // behind another one, so its item and field are in Decisions.
  await openChat(page, pc.chat('front', true, false, 'note').id);
  await pc.ask(s.id, 'bash', 'Bash', { command: 'ls -la', description: 'List files' });
  const item = await card(page, pc, s.id);
  await expect(item.locator('.dc-note')).toBeVisible();
  await pc.leaseOver();
  // The tool row above the prompt blinks while it waits: the item keeps its id, so the typed text stays.
  await item.locator('.dc-note').fill('Do not list, just stop.');
  const id = await item.getAttribute('data-item');
  pc.draw(s.id, 'blink');
  await page.waitForTimeout(400);
  await expect(item.locator('.dc-note')).toHaveValue('Do not list, just stop.');
  expect(pc.pending().map((d) => d.id)).toEqual([id]);
  await item.locator('[data-act="deny"]').click();
  await expect.poll(async () => (await answers(page)).map((a) => (a as unknown as { answer: unknown }).answer)).toContainEqual({ type: 'deny_with', text: 'Do not list, just stop.' });
  // Denied with Esc, then the instruction is typed as the next message once the prompt is gone.
  await expect.poll(() => pc.screen(s.id), { timeout: 8000 }).toContain('answered Do not list, just stop.');
});

// After one Codex look: the card shows where a write goes and never an empty body for a request it does not know.
test('q_perm_card_shows_the_whole_path_and_unknown_requests_whole', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string, vars?: Record<string, string>) => `${key}:${vars?.file ?? ''}`) as never;
  const card = (input: unknown) => readable({ kind: 'permission', text: JSON.stringify(input) } as never, t)!;
  const config = card({ file_path: '/srv/agent/.claude/settings.json', old_string: 'a', new_string: 'b' });
  const project = card({ file_path: '/work/app/settings.json', old_string: 'a', new_string: 'b' });
  expect(config.what).toBe(project.what); // the title names the file only
  expect(config.body.split('\n')[0]).toBe('/srv/agent/.claude/settings.json');
  expect(project.body.split('\n')[0]).toBe('/work/app/settings.json');
  expect(card({ file_path: '/work/app/new.txt', content: 'hello' }).body).toBe('/work/app/new.txt\nhello');
  const cell = card({ notebook_path: '/work/app/analysis.ipynb', new_source: 'import os', cell_id: 'c1', edit_mode: 'replace' });
  for (const part of ['analysis.ipynb', 'import os', 'replace', 'c1']) expect(cell.body).toContain(part);
  // "Replace every occurrence" must not read as one edit: the words say it (look 1117 v10 N10-S3-7: it was raw JSON).
  const one = card({ file_path: '/work/app/a.txt', old_string: 'a', new_string: 'b', replace_all: false });
  const all = card({ file_path: '/work/app/a.txt', old_string: 'a', new_string: 'b', replace_all: true });
  expect(one.body).toBe('/work/app/a.txt\n-a\n+b');
  expect(all.body).toBe('/work/app/a.txt\ndecisions.everyPlace:\n-a\n+b');
  // A field the words do not show keeps the request whole.
  expect(card({ file_path: '/work/app/a.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' }).body).toContain('"replace_all": "yes"');
  expect(card({ command: 'ls', description: 'List', timeout: 1000 }).body).toBe('ls');
  expect(card({ command: 'ls', dangerouslyDisableSandbox: true }).body).toContain('"dangerouslyDisableSandbox": true');
  expect(card({ questions: [null] }).body).toContain('"questions"');
  expect(card({ file_path: '/work/app/a.txt', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }).body).toBe('/work/app/a.txt\ndecisions.everyPlace:\n-a\n+b');
});

// Look 11-17 N1: Claude 2.1.326's question dialog, read from the screen, draws a second rule above "4. Chat about this";
// the card shows the question and every option, not the tail below that rule.
test('n1_screen_question_card_shows_the_question_and_its_choices', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const text = `❯ ask me\n${RULE}\n ☐ Name\n\nWhich name should go in the first-line comment\nof test_app.py?\n\n❯ 1. alpha\n  2. beta\n  3. Type something.\n${RULE}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  const card = readable({ kind: 'question', text } as never, t)!;
  expect(card.what).toBe('Which name should go in the first-line comment of test_app.py?');
  for (const part of ['1. alpha', '2. beta', '4. Chat about this']) expect(card.body).toContain(part);
});

// Look 1117 v10 Home S3-1: a question card showed its question twice (its line and the box); the box shows only what the
// line and the option buttons do not say (an option's description).
test('question_card_box_only_adds_what_the_line_and_buttons_do_not_say (Home S3-1)', async () => {
  const { questionRest, readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const text = `❯ ask me\n${RULE}\n ☐ Name\n\nWhich name should go in the first-line comment\nof test_app.py?\n\n❯ 1. alpha\n  2. beta\n  3. Type something.\n${RULE}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  const card = readable({ kind: 'question', text } as never, t)!;
  expect(questionRest(card.body, card.what, ['alpha', 'beta', 'Type something.', 'Chat about this'])).toBe('');
  expect(questionRest(card.body, card.what, ['alpha', 'beta'])).toBe('3. Type something.\n4. Chat about this');
  const hook = readable({ kind: 'question', text: JSON.stringify({ questions: [{ question: 'Which currency?', options: [{ label: 'USD', description: 'US dollar' }, { label: 'EUR' }] }] }) } as never, t)!;
  expect(questionRest(hook.body, hook.what, ['USD', 'EUR'])).toBe('1. USD — US dollar');
});

// Sixth look (B6-S3-3): a question read from the screen was cut to the part after its colon ("alpha or beta?"); the card's
// line is the question the agent asked. A dialog still reads from the start of its sentence ("Trust this folder?").
test('screen_question_card_line_is_the_whole_question', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const text = `❯ ask me\n${RULE}\n ☐ Name\n\n│ Which name should I use\nfor the first-line\n│ comment in test_app.py:\nalpha or beta?\n\n❯ 1. alpha\n  2. beta\n  3. Type something.\n${RULE}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
  expect(readable({ kind: 'question', text } as never, t)!.what).toBe('Which name should I use for the first-line comment in test_app.py: alpha or beta?');
  expect(readable({ kind: 'dialog', text: 'Folder access\n/tmp/p\nQuick safety check: Trust this folder?\n❯ 1. Yes\n  2. No' } as never, t)!.what).toBe('Trust this folder?');
});

// w25-m: a start question Claude cut off in a short window (only "No" takes, its hint says make the window taller) says so in
// plain words on the card's line.
test('w25m_cut_off_start_question_card_says_make_the_window_taller', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const text = ' Adding a new directory:\n ↓ No, exit\n Esc to exit · To add it, first make the window\n taller';
  expect(readable({ kind: 'dialog', text } as never, t)!.what).toBe('decisions.windowShort');
});

// Look 1117 v17 B (w25-s): a narrow window wraps the trust question past the terminal's rows; its heading scrolls off and
// only its option rows are left. The card says to make the window taller; with the heading on screen it reads as before.
test('w25s_start_question_without_its_heading_says_make_the_window_taller', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const cut = ' what\'s in this folder first.\n\n Security guide\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm ·\n Esc to cancel';
  expect(readable({ kind: 'dialog', text: cut } as never, t)!.what).toBe('decisions.windowShort');
  const whole = ' Accessing workspace:\n\n /tmp/harbor\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder';
  expect(readable({ kind: 'dialog', text: whole } as never, t)!.what).not.toBe('decisions.windowShort');
});

// Look 1117 v4 (home N9): a question read from a framed screen kept the frame's gutter: "What │ What text should…".
test('question_from_screen_drops_the_frame_gutter (N9)', async () => {
  const { readable } = await import('../src/decisions/readable');
  const t = ((key: string) => key) as never;
  const card = readable({ kind: 'question', text: '╭──────────╮\n│ What text should the one line in NOTES.md be?\n│ ❯ 1. Type something\n╰──────────╯' } as never, t)!;
  expect(card.what).toBe('What text should the one line in NOTES.md be?');
});

// Home N-D (look 1117 v4f): a question's option line with a long path ("2 Yes, and always allow access to /private/var/folders/…")
// ran past the card's right edge. It wraps inside the card.
t('long_option_line_stays_in_the_card (N-D)', async ({ page, pc }) => {
  const s = pc.chat('opts');
  await openChat(page, s.id);
  const right = await page.evaluate(() => {
    const card = Object.assign(document.createElement('div'), { className: 'deccard' });
    card.style.cssText = 'width:300px;position:fixed;left:10px;top:10px';
    card.innerHTML = '<div class="dc-btns"><span class="opt">2 Yes, and always allow access to /private/var/folders/jr/yqyyd28j0z94g1w76lmd37hh0000gn/T/ns-click-9x5s3324/demo-shop from this project</span></div>';
    document.body.append(card);
    const [c, o] = [card.getBoundingClientRect(), card.querySelector('.opt')!.getBoundingClientRect()];
    card.remove();
    return o.right - c.right;
  });
  expect(right).toBeLessThanOrEqual(1);
});
