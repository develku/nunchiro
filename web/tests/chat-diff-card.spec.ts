// Ticket v1b-12: the chat diff card's View / Accept / Reject. Real core, a fake Claude whose transcript the test
// writes; "PERM <hook payload>" typed into its PTY asks through the real PermissionRequest hook and draws the
// permission dialog, as Claude does (real agent: chat-diff-card.real.spec.ts via scripts/scenario/v1b-diff-card.sh).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { append, chat, ChatCore, expect, openChat, rec, test } from './fixtures/chat/harness';
import { openSessionFromPalette, stripOnTop, REPO, stripBeside } from './fixtures';
import { icon, sidebar } from './d5b';

const BIN = path.join(REPO, 'target/debug/nunchiro');
// Reads its PTY byte by byte so Esc (deny) and "1⏎" (allow) both reach it; a hook answer clears the dialog, as in Claude.
const FAKE = (home: string) => `#!/bin/sh
if [ "$1" = --version ]; then cat '${home}/fake-version'; exit; fi
stty -icanon -echo min 1 2>/dev/null
printf 'fake chat agent\\r\\n'
esc=$(printf '\\033'); cr=$(printf '\\r'); line=''
# Claude Code 2.1.310's edit prompt for the tests' a.txt edit (old -> new): rule, diff, prompt line, choices.
dialog() { printf '\\033[2J\\033[H\\342\\217\\272 Update(a.txt)\\r\\n\\r\\n%s\\r\\n Edit file\\r\\n a.txt\\r\\n%s\\r\\n 1 -old\\r\\n 1 +new\\r\\n%s\\r\\n Do you want to make this edit to a.txt?\\r\\n > 1. %s\\r\\n   2. No\\r\\n\\r\\n Esc to cancel\\r\\n' '${'\u2500'.repeat(60)}' '${'\u254c'.repeat(60)}' '${'\u254c'.repeat(60)}' "$1"; }
ask() { out='${home}'/hook-$$.out; printf '%s' "$1" | '${BIN}' hook PermissionRequest > "$out" 2>&1; grep -q behavior "$out" && printf '\\033[2J\\033[Hhook answered\\r\\n'; }
while :; do
  c=$(dd bs=1 count=1 2>/dev/null)
  if [ "$c" = "$esc" ]; then printf '\\033[2J\\033[Hdenied\\r\\n'; line=''; continue; fi
  if [ -n "$c" ] && [ "$c" != "$cr" ]; then line="$line$c"; continue; fi
  case "$line" in
    EXIT) exit 0 ;;
    STOP) printf '{}' | '${BIN}' hook UserPromptSubmit >/dev/null 2>&1; printf '{}' | '${BIN}' hook Stop >/dev/null 2>&1 ;;
    PERM\\ *) ask "\${line#PERM }" & dialog Yes ;;
    PERSIST\\ *) ask "\${line#PERSIST }" & dialog "Yes, and don't ask again for this file" ;;
    '') ;;
    *) printf '\\033[2J\\033[Hanswered %s\\r\\n' "$line" ;;
  esac
  line=''
done
`;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

class CardCore extends ChatCore {
  constructor(id: string) {
    super(id);
    fs.writeFileSync(path.join(this.home, 'bin/claude'), FAKE(this.home), { mode: 0o700 });
  }
  /** A fake Claude session in a git project with `a.txt` committed (Diff compares with that commit). */
  card(label = 'card') {
    const dir = this.project(label);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    const s = this.cli('session', 'start', '--kind', 'claude', '--project', dir, '--label', label).session as { id: string; cwd: string; agent_session_id: string };
    const file = this.transcriptPath(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return { ...s, file, dir };
  }
  /** Asks through the hook (payload as Claude sends it) and draws the dialog. */
  ask(id: string, tool_name: string, tool_input: unknown, persistent = false) {
    this.cli('session', 'send-text', id, `${persistent ? 'PERSIST' : 'PERM'} ${JSON.stringify({ tool_name, tool_input })}\r`);
  }
  pending(): { id: string; kind: string; text: string; choices: unknown[]; actionable: boolean }[] {
    return this.cli('snapshot', '--json').sessions.flatMap((s: { pending: unknown[] }) => s.pending);
  }
}

const test2 = test.extend<{ cc: CardCore }>({
  cc: async ({ page }, use, info) => {
    const core = new CardCore(`card-${info.workerIndex}-${info.testId.slice(0, 8)}`);
    await core.ready();
    await page.addInitScript((boot) => {
      window.__NUNCHIRO__ = boot;
      // Every request any socket of this window sends, and every diff.open.
      const w = window as unknown as { __sent: { op: string }[]; __diff: unknown[] };
      w.__sent = [];
      w.__diff = [];
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
      window.addEventListener('nunchiro:diff.open', (e) => w.__diff.push((e as CustomEvent).detail));
    }, core.boot());
    await use(core);
    await core.stop();
  },
});

const answers = (page: Page) => page.evaluate(() => (window as unknown as { __sent: { op: string }[] }).__sent.filter((r) => r.op === 'answer'));
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __diff: unknown[] }).__diff);
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(REPO, '.scratch/shots', `v1b-12-${name}-${test.info().project.name}.png`) });
const strip = (page: Page) => page.locator('#waiting-strip .qcard[data-item]');
const acts = (card: Locator) => card.locator('.dacts button', { hasText: /^(Allow once|Deny)$/ });
const EDIT = (dir: string) => ({ file_path: path.join(dir, 'a.txt'), old_string: 'old', new_string: 'new' });
/** Waits out the card's stray-click guard (500 ms from when the buttons appear). */
async function armed(button: Locator) {
  await expect(button).toBeVisible();
  await button.page().waitForTimeout(600);
}

test2('chat diff card: a pending permission edit shows Accept/Reject; Accept sends allow once and the strip line goes', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const view = chat(page, s.id);
  append(s.file, rec.user('a.txt 고쳐줘'), rec.use('e1', 'Edit', EDIT(s.dir)));
  const card = view.locator('.dcard');
  // The pending card renders from the call input before any edit event.
  await expect(card.locator('.counts')).toHaveText('+1 −1');
  await expect(card.locator('.dl .d')).toHaveText('-old');
  // V1A-58: the drag layer's old global `.dl` rule centred this card's lines and drew a box round them.
  await expect(card.locator('.dl')).toHaveCSS('text-align', 'start');
  await expect(card.locator('.dl')).toHaveCSS('display', 'block');
  await expect(acts(card)).toHaveCount(0);
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(strip(page)).toHaveCount(1);
  const item = await strip(page).getAttribute('data-item');
  await armed(card.getByRole('button', { name: 'Allow once' }));
  expect(await card.locator('.dacts button').allTextContents()).toEqual(['View', 'Allow once', 'Deny']);
  await shot(page, 'pending-and-strip');
  await card.getByRole('button', { name: 'Allow once' }).click();
  await expect(strip(page)).toHaveCount(0, { timeout: 2000 });
  await expect(acts(card)).toHaveCount(0, { timeout: 1000 });
  expect(cc.pending()).toEqual([]);
  expect(await answers(page)).toEqual([{ op: 'answer', item, answer: { type: 'allow_once' }, confirmed: false }]);
});

test2('chat_edit_row_relative_and_waiting (ticket 581): the path reads relative; a pending edit says it waits for approval until its result', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const view = chat(page, s.id);
  append(s.file, rec.user('a.txt 고쳐줘'), rec.use('e1', 'Edit', EDIT(s.dir)));
  const card = view.locator('.dcard');
  await expect(card.locator('.dh .path')).toHaveText('a.txt');
  await expect(card.locator('.counts')).toHaveText('+1 −1');
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(strip(page)).toHaveCount(1);
  await expect(card.locator('.counts')).toHaveText('+1 −1 · waiting for approval');
  await shot(page, 'waiting-approval');
  const [, result] = rec.edit('e1', path.join(s.dir, 'a.txt'), ['-old', '+new']);
  append(s.file, result);
  await expect(view.locator('.dwait')).toHaveCount(0);
});

test2('B10 (ticket 991): in a narrow chat the card name stays one line with the path as its tooltip, and Accept/Reject stay reachable', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const edit = { file_path: path.join(s.dir, 'test_app.py'), old_string: 'old', new_string: 'new' };
  append(s.file, rec.user('fix it'), rec.use('e1', 'Edit', edit));
  cc.ask(s.id, 'Edit', edit);
  const card = view.locator('.dcard');
  await armed(card.getByRole('button', { name: 'Allow once' }));
  await card.evaluate((el) => void ((el as HTMLElement).style.width = '200px')); // a side pane squeezes the chat
  const name = card.locator('.dh .path');
  await expect(name).toHaveAttribute('title', 'test_app.py');
  expect((await name.boundingBox())!.height).toBeLessThan(24); // one line, not a letter per line
  const box = (await card.boundingBox())!;
  for (const b of ['Allow once', 'Deny']) {
    const r = (await card.getByRole('button', { name: b }).boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
});

test2('chat diff card: Reject sends deny, the same request the strip sends', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(strip(page)).toHaveCount(1);
  const item = await strip(page).getAttribute('data-item');
  await armed(card.getByRole('button', { name: 'Deny' }));
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(strip(page)).toHaveCount(0, { timeout: 2000 });
  await expect(acts(card)).toHaveCount(0, { timeout: 1000 });
  expect(await answers(page)).toEqual([{ op: 'answer', item, answer: { type: 'deny' }, confirmed: false }]);
});

test2('N13-S2-3: Send while a hook permission waits answers nothing; the text is held and the card stays', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  append(s.file, rec.user('run it'), rec.use('b1', 'Bash', { command: 'make deploy' }));
  cc.ask(s.id, 'Bash', { command: 'make deploy' });
  await expect(strip(page)).toHaveCount(1);
  const item = await strip(page).getAttribute('data-item');
  const box = page.locator('#composer');
  await expect(box).toHaveAttribute('placeholder', /^Answer its question first\. A message you send now waits until you answer\./); // ticket 1030 adds the Shift+Tab hint
  await box.fill('use make test instead');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await page.waitForTimeout(500);
  // Held by the window (a first message) or by the core (a composer send); never the card's deny.
  expect(await answers(page)).toEqual([]);
  expect(cc.pending().map((d) => d.id)).toEqual([item]);
  await expect(strip(page)).toHaveCount(1);
});

test2('N14-S3-1: a message the core holds behind a permission shows as held, and Cancel send puts it back in the box', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  cc.cli('session', 'send-text', s.id, 'STOP\r'); // one finished turn: the core holds the send, not the window
  await expect.poll(() => cc.cli('snapshot', '--json').sessions.find((x: { id: string }) => x.id === s.id).completion_seq).toBe(1);
  cc.ask(s.id, 'Bash', { command: 'make deploy' });
  await expect(strip(page)).toHaveCount(1);
  const box = page.locator('#composer');
  await box.fill('use make test instead');
  await box.press('Enter');
  const held = page.locator('.composer .queued.held');
  await expect(held).toContainText('Held until you answer:');
  await expect(held).toContainText('use make test instead');
  await held.getByRole('button', { name: 'Cancel send' }).click();
  await expect(held).toHaveCount(0);
  await expect(box).toHaveValue('use make test instead');
  expect(await answers(page)).toEqual([]);
});

/** What the core told the fake's PermissionRequest hook (the last answer). */
const hookOut = (cc: CardCore) => fs.readdirSync(cc.home).filter((f) => /^hook-.*\.out$/.test(f)).map((f) => fs.readFileSync(path.join(cc.home, f), 'utf8')).join('\n');

test2('N12-S2-3: a Deny on another surface carries the instruction typed in the Decisions card (chat card Deny of a risky edit)', async ({ page, cc }) => {
  const s = cc.card();
  // A write outside the session folder is risky: the front session's item is in Decisions with its field too.
  const outside = { file_path: path.join(cc.home, 'outside.txt'), old_string: 'old', new_string: 'new' };
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', outside));
  cc.ask(s.id, 'Edit', outside);
  await icon(page, 'right', 'Decisions').click();
  await sidebar(page, 'right').locator(`.deccard[data-session="${s.id}"] .dc-note`).fill('use other.txt instead');
  await armed(card.getByRole('button', { name: 'Deny' }));
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect.poll(async () => (await answers(page)).map((a) => (a as unknown as { answer: unknown }).answer)).toEqual([{ type: 'deny_with', text: 'use other.txt instead' }]);
});

test2('v34 S3-4: one Deny on the card above the composer stops the turn (the hook is told interrupt), as a deny with words', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  const docked = page.locator(`.composer .deccard.docked[data-session="${s.id}"]`);
  await expect(docked.locator('.dc-note')).toHaveCount(0);
  await armed(docked.locator('[data-act="deny"]'));
  await docked.locator('[data-act="deny"]').click();
  await expect.poll(() => hookOut(cc), { timeout: 8000 }).toContain('"behavior":"deny"');
  expect(hookOut(cc)).toContain('"interrupt":true');
  expect(cc.pending()).toEqual([]);
});

test2('chat diff card: finished edits show no buttons', async ({ page, cc }) => {
  const s = cc.card();
  // History: a finished edit, and an unresolved call from an earlier run whose permission is long gone.
  append(s.file, rec.edit('e0', path.join(s.dir, 'a.txt'), ['-old', '+new']), rec.use('e9', 'Write', { file_path: path.join(s.dir, 'b.txt'), content: 'x\ny\n' }));
  await openChat(page, s.id);
  const view = chat(page, s.id);
  const cards = view.locator('.dcard');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1).locator('.counts')).toHaveText('+2 −0');
  await expect(acts(cards.first())).toHaveCount(0);
  await expect(acts(cards.nth(1))).toHaveCount(0);
  // A live one: pending with buttons, then its result arrives and the normal card replaces it in place.
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  const live = cards.nth(2);
  await expect(live.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(strip(page)).toHaveCount(1);
  await shot(page, 'pending-finished-strip');
  const key = await view.locator('.crow').nth(2).getAttribute('data-key');
  const [, result] = rec.edit('e1', path.join(s.dir, 'a.txt'), ['-old', '+new', '+more']);
  append(s.file, result);
  await expect(live.locator('.counts')).toHaveText('+2 −1');
  await expect(acts(live)).toHaveCount(0);
  await expect(view.locator('.crow').nth(2)).toHaveAttribute('data-key', key!);
  await expect(view.locator('.dcard .dacts button', { hasText: 'View' })).toHaveCount(3);
  await shot(page, 'finished');
});

test2('chat diff card: View opens Diff at the file', async ({ page, cc }) => {
  const s = cc.card();
  fs.writeFileSync(path.join(s.dir, 'a.txt'), 'new\n');
  append(s.file, rec.edit('e0', path.join(s.dir, 'a.txt'), ['-old', '+new']));
  await openChat(page, s.id);
  await chat(page, s.id).locator('.dcard').getByRole('button', { name: 'View' }).click();
  expect(await opened(page)).toEqual([{ path: 'a.txt' }]);
  await expect(page.locator('[data-path="a.txt"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Diff of a.txt' })).toBeVisible();
});

test2('chat diff card: a path outside the session folder or a deleted file opens Diff without a path and says why', async ({ page, cc }) => {
  const s = cc.card();
  append(s.file, rec.edit('e0', '/elsewhere/x.txt', ['+x']), rec.use('e1', 'Write', { file_path: path.join(path.dirname(s.dir), 'sibling.txt'), content: 'y' }));
  await openChat(page, s.id);
  const cards = chat(page, s.id).locator('.dcard');
  await cards.first().getByRole('button', { name: 'View' }).click();
  await expect(cards.first()).toContainText('outside the session folder');
  await cards.nth(1).getByRole('button', { name: 'View' }).click();
  await expect(cards.nth(1)).toContainText('outside the session folder');
  expect(await opened(page)).toEqual([{}, {}]);
});

test2('chat diff card: never sends a persistent choice', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  // The only allow on screen is "Yes, and don't ask again": it changes settings.
  cc.ask(s.id, 'Edit', EDIT(s.dir), true);
  await expect.poll(() => cc.pending()[0]?.choices.length ?? 0).toBe(2);
  await armed(card.getByRole('button', { name: 'Deny' }));
  await expect(card.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Deny' }).click();
  await expect(strip(page)).toHaveCount(0, { timeout: 2000 });
  const sent = await answers(page);
  expect(sent.map((a) => (a as unknown as { answer: { type: string } }).answer.type)).toEqual(['deny']);
});

test2('chat diff card: two identical pending edits show no buttons; one item with two cards marks only its own', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const cards = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)), rec.use('e2', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(strip(page)).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(acts(cards.first())).toHaveCount(0);
  await expect(acts(cards.nth(1))).toHaveCount(0);
  // The strip still answers it.
  await strip(page).locator('.what').click();
  await strip(page).getByRole('button', { name: 'Deny' }).click();
  await expect.poll(() => cc.pending()).toEqual([]);
  // Two different calls, one item: only the card whose input it carries.
  const other = { file_path: path.join(s.dir, 'b.txt'), content: 'b\n' };
  append(s.file, rec.result('e1', 'denied', {}, true), rec.result('e2', 'denied', {}, true), rec.use('e3', 'Write', other), rec.use('e4', 'Edit', EDIT(s.dir)));
  await page.mouse.move(700, 120);
  cc.ask(s.id, 'Write', other);
  // Under load the screen may file the prompt before the hook lands; the card matches once the hook's input is there.
  await expect.poll(() => cc.pending()[0]?.text.startsWith('{'), { timeout: 10_000 }).toBe(true);
  const b = cards.filter({ hasText: 'b.txt' });
  await expect(b.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await expect(acts(cards.filter({ hasText: 'a.txt' }))).toHaveCount(0);
});

test2('chat diff card: answering from the strip removes the card buttons within 1 s; one request in total', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
  await strip(page).locator('.what').click();
  await strip(page).getByRole('button', { name: 'Allow once' }).click();
  const t0 = Date.now();
  await expect(acts(card)).toHaveCount(0, { timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);
  expect((await answers(page)).length).toBe(1);
});

test2('chat diff card: a restored item or a session not running shows no buttons and says "answer in the terminal"', async ({ page, cc }) => {
  const s = cc.card();
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect.poll(() => cc.pending().length).toBe(1);
  // K-CRASH: the core restarts; the item comes back reconciled and not actionable.
  cc.cli('serve', 'stop');
  await cc.restart();
  // V2.5-87 (ticket 301): the session ended with the core, so its restored item is kept on disk but not shown.
  await expect.poll(() => cc.pending().length).toBe(0);
  // The restarted core has a new port and token.
  await page.addInitScript((boot) => {
    window.__NUNCHIRO__ = boot;
  }, cc.boot());
  await page.goto('/');
  // An ended session opens from the command palette (no tab is restored for it), read-only.
  await openSessionFromPalette(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  // The restored item comes back reconciled but not actionable, which `plan()` (queue/answer.ts) words as "checking · restored
  // after a restart" until fresh evidence proves it again (V2-1b); "answer in the terminal" is the Strip's terminal list now
  // (v2-8e r2, b210f01a: a risky allow is made only in the Decisions card, needs 107; 8c00145e: one Diff control, needs 109).
  // The title keeps its old words so the test stays findable; the safety half, no answer control on the card, is unchanged.
  // V2.5-87 (ticket 301): an ended session holds no decision, so no waiting line and no answer control (was the restored card's
  // "checking · restored after a restart"; a running session's restored card keeps it, queue.spec.ts).
  // Ticket 670: the transcript's edit still draws its card once it loads (a count of 0 passed only before it loaded); the
  // card offers no answer and does not say it waits.
  await expect(card).toBeVisible();
  await expect(acts(card)).toHaveCount(0);
  await expect(card).not.toContainText('waiting for approval');
});

test2('chat diff card: stray clicks do nothing (buttons younger than 500 ms, or a press that started before they rendered)', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  await expect(card).toBeVisible();
  const box = (await card.locator('.dask').boundingBox())!;
  // A press held where the buttons will appear, released after they did.
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.mouse.down();
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await answers(page)).toEqual([]);
  // A press held on Accept while the agent asks again: a new item takes the same button; releasing answers nothing.
  const first = cc.pending()[0].id;
  const accept = (await card.getByRole('button', { name: 'Allow once' }).boundingBox())!;
  await page.mouse.move(accept.x + accept.width / 2, accept.y + accept.height / 2);
  await page.mouse.down();
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect.poll(() => cc.pending()[0]?.id).not.toBe(first);
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await answers(page)).toEqual([]);
  expect(cc.pending().length).toBe(1);
});

test2('chat diff card: a just-shown card ignores an immediate click, then answers once armed', async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  await expect(card).toBeVisible();
  // Ticket 670: the page presses Accept in the task that draws it, then again 600 ms later. A Playwright click can land
  // more than 500 ms after the draw (its retry backoff, or load), which arms the guard; and the armed click must come
  // inside the hook's 1.4 s wait (server.rs), because this fake agent never answers through its screen.
  await page.evaluate(() => {
    const w = window as unknown as { __clicks?: number[]; __sent: { op: string }[] };
    const press = (b: HTMLButtonElement) => {
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    };
    const accept = () => [...document.querySelectorAll<HTMLButtonElement>('.dcard .dask button')].find((x) => x.textContent === 'Allow once');
    const mo = new MutationObserver(() => {
      const b = accept();
      if (!b) return;
      mo.disconnect();
      press(b);
      // Answers sent before the armed press: an early answer the guard let through shows here (and removes the button).
      setTimeout(() => {
        w.__clicks = [w.__sent.filter((r) => r.op === 'answer').length];
        const again = accept();
        if (again) press(again);
      }, 600);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __clicks?: number[] }).__clicks)).toEqual([0]);
  await expect.poll(() => cc.pending()).toEqual([]);
  expect((await answers(page)).length).toBe(1);
});

test2('chat diff card: a Hangul IME composition keydown never answers', { tag: '@chromium' }, async ({ page, cc }) => {
  const s = cc.card();
  await openChat(page, s.id);
  const card = chat(page, s.id).locator('.dcard');
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await armed(card.getByRole('button', { name: 'Allow once' }));
  const cdp = await page.context().newCDPSession(page);
  // On a focused Accept: a composing Enter is the IME's, never a click.
  await card.getByRole('button', { name: 'Allow once' }).focus();
  await page.evaluate(() => {
    const b = document.activeElement as HTMLElement;
    for (const key of ['Enter', ' ']) b.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === 'Enter' ? 'Enter' : 'Space', isComposing: true, bubbles: true, cancelable: true }));
  });
  // In the composer, mid-composition, the arrival never takes focus and Enter commits the syllable only.
  await page.locator('.cbox textarea').focus();
  await cdp.send('Input.imeSetComposition', { text: '가', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '가' });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('composer');
  expect(await answers(page)).toEqual([]);
  expect(cc.pending().length).toBe(1);
});

test2('chat diff card: a card arriving while scrolled up moves nothing; the buttons reserve their width from first paint', async ({ page, cc }) => {
  const s = cc.card();
  append(s.file, Array.from({ length: 40 }, (_, i) => [rec.user(`질문 ${i}`), rec.assistant(`답 ${i}\n\n둘째 문단 ${i}`)]).flat());
  await openChat(page, s.id);
  const view = chat(page, s.id);
  await expect(view.getByText('답 39')).toBeVisible();
  await view.locator('.cscroll').hover();
  await page.mouse.wheel(0, -900);
  await expect.poll(() => view.locator('.cscroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(400);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(300);
  const rows = () =>
    view.evaluate((el) => {
      const sc = el.querySelector('.cscroll')!.getBoundingClientRect();
      return [...el.querySelectorAll('.crow')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.bottom > sc.top && r.top < sc.bottom;
        })
        .map((e) => {
          const r = e.getBoundingClientRect();
          return `${(e as HTMLElement).dataset.key}:${[r.x, r.y, r.width, r.height].map(Math.round).join(',')}`;
        });
    });
  const before = await rows();
  append(s.file, rec.use('e1', 'Edit', EDIT(s.dir)));
  await expect(view.locator('.newchip')).toBeVisible();
  cc.ask(s.id, 'Edit', EDIT(s.dir));
  await expect(strip(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  // V1A-60b (needs 77): the strip shrinks the chat from below, so a row may leave at the bottom; the rest stay put.
  const after = await rows();
  expect(after.length).toBeGreaterThan(0);
  expect(after).toEqual(before.slice(0, after.length));
  // The card at the bottom: its action slot is as wide with buttons as it was before the item arrived.
  await view.locator('.newchip').click();
  const card = view.locator('.dcard');
  await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
  const withButtons = (await card.locator('.dask').boundingBox())!;
  const header = (await card.locator('.dh').boundingBox())!;
  await strip(page).locator('.what').click();
  await strip(page).getByRole('button', { name: 'Deny' }).click();
  await expect(acts(card)).toHaveCount(0);
  const without = (await card.locator('.dask').boundingBox())!;
  expect([without.width, without.height]).toEqual([withButtons.width, withButtons.height]);
  expect((await card.locator('.dh').boundingBox())!.height).toBe(header.height);
});

// Detailed-row coverage explicitly selects Verbose; the window now starts in Normal.
test2.beforeEach(async ({ page, cc }) => {
  await page.addInitScript(() => localStorage.setItem('nunchiro.chatView.v2', 'verbose'));
  // needs 107 (ticket 180): the strip is not drawn above the composer; a spec that pins "moves nothing" puts it in its own zone.
  if (/moves nothing/.test(test2.info().title)) stripBeside(cc);
  else stripOnTop(cc);
});
