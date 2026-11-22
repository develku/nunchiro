// Ticket 489 (scorecard F10): a first-time user walk. Opt-in (WALK=1, chromium): it drives the window by visible text and
// roles only, as a person would, and leaves a numbered shot and the visible text of each step in .scratch/walk/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, REPO, test, type Core } from './fixtures';

// A fake Claude that acts like a first session: it answers the first message, asks before it edits README.md, then edits
// it. It writes its transcript where Claude does, so the chat view has a conversation to show.
const WALK_CLAUDE = () => `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
if [ "$1 $2" = "auth status" ]; then exit 2; fi
sid=""; prev=""
for a in "$@"; do case "$prev" in --session-id|--resume) sid="$a";; esac; prev="$a"; done
t="$CLAUDE_CONFIG_DIR/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$t"; t="$t/$sid.jsonl"
say() { printf '{"type":"assistant","uuid":"%s","message":{"role":"assistant","content":[{"type":"text","text":"%s"}]}}\\n' "$1" "$2" >> "$t"; printf '%s\\r\\n' "$2"; }
# Claude's input box and footer for the default full access (ticket 362): the composer's mode chip reads it.
printf 'fake agent ready\\r\\n%s\\r\\n❯ \\r\\n%s\\r\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\r\\n' '${'─'.repeat(60)}' '${'─'.repeat(60)}'
IFS= read -r msg
printf '{"type":"user","uuid":"u1","message":{"role":"user","content":"%s"}}\\n' "$msg" >> "$t"
say a1 'I will add a hello line to README.md.'
printf '{"type":"assistant","uuid":"a1t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"%s/README.md","old_string":"","new_string":"hello"}}]}}\\n' "$(pwd)" >> "$t"
printf '{"session_id":"%s","hook_event_name":"PermissionRequest","tool_name":"Edit","tool_input":{"file_path":"%s/README.md","old_string":"","new_string":"hello"}}' "$sid" "$(pwd)" | '${path.join(REPO, 'target/debug/nunchiro')}' hook PermissionRequest
# A real TUI redraws on SIGWINCH; the core drops its screen copy on a resize and waits for that redraw.
draw() { printf '\\033[2J\\033[H%s\\r\\n Do you want to proceed?\\r\\n ❯ 1. Yes\\r\\n   2. No\\r\\n\\r\\n Esc to cancel\\r\\n' '${'─'.repeat(60)}'; }
trap draw WINCH; draw
# Polls (0.2 s) so the WINCH trap runs between reads; a blocking read would hold it until a key comes.
stty -icanon min 0 time 2; until x=$(dd bs=1 count=1 2>/dev/null) && [ -n "$x" ]; do :; done; stty icanon; trap - WINCH
echo hello >> README.md
printf '{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\\n' >> "$t"
say a2 'Done: README.md has a hello line.'
exec sleep 600
`;

// Ticket 582: the turn hooks a real Claude sends over the owner socket (as chat-stop.spec.ts); the fake agent sends none, and the
// core counts a finished turn (`completion_seq`, what the first-session step reads) from "UserPromptSubmit" then "Stop".
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
const turn = (core: Core, id: string) => {
  for (const event of ['UserPromptSubmit', 'Stop']) execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 });
};

const OUT = path.join(REPO, '.scratch/walk');
let n = 0;
async function look(app: Page, name: string) {
  const id = String(++n).padStart(2, '0');
  await app.waitForTimeout(300); // let the step's own motion settle so the shot shows what a person sees
  await app.screenshot({ path: path.join(OUT, `${id}-${name}.png`) });
  const text = (await app.locator('body').innerText()).replace(/\n{2,}/g, '\n');
  fs.appendFileSync(path.join(OUT, 'steps.log'), `\n## ${id} ${name}\n${text}\n`);
}

/** One job: when it gets stuck, the shot and the error go to the log and the walk goes on, as a person would try the next
 *  job; the test still fails at the end, naming every stuck job. */
const stuck: string[] = [];
async function job(app: Page, name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    stuck.push(`${name}: ${String(e).split('\n')[0]}`);
    fs.appendFileSync(path.join(OUT, 'steps.log'), `\n!! STUCK in ${name}: ${String(e).split('\n').slice(0, 3).join(' ')}\n`);
    await look(app, `${name}-stuck`);
  }
}

async function closeDialogs(app: Page) {
  for (let i = 0; i < 3 && (await app.getByRole('dialog').count()); i++) await app.keyboard.press('Escape');
}
async function openSettings(app: Page) {
  await closeDialogs(app);
  await app.getByRole('button', { name: /^(Settings|설정)$/ }).last().click();
  await expect(app.getByRole('dialog').first()).toBeVisible();
}

test.skip(({ browserName }) => browserName !== 'chromium', 'chromium only');
test.use({ firstRun: true, actionTimeout: 8000 });
test.setTimeout(400_000);

test('first_use_walk: ten first-use jobs, by visible text and roles only', async ({ app, core }) => {
  test.skip(process.env.WALK !== '1', 'opt-in walk: WALK=1');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(core.home, 'bin/claude'), WALK_CLAUDE(), { mode: 0o700 });
  const repo = core.project('my-app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'README.md'), '# my app\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);

  // The browser build has no native folder panel: this stand-in answers it with the seeded repository, as the
  // onboarding specs do. Everything else is the window's own path.
  await app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, repo);

  // Job 1: first open.
  await app.goto('/');
  await look(app, 'first-open');
  // Fixed in 489: the first screen says what the app is.
  await expect(app.getByText(/runs your coding agents, each in its own tab/)).toBeVisible();

  // Job 2: add a project. The setup list's "Add your first project" is where a person goes.
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await settings.getByText('Add your first project').click();
  await look(app, 'onboarding-project-step');
  await settings.getByRole('button', { name: 'Add project' }).click();
  await look(app, 'add-project-dialog');
  await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Browse folder/ }).click();
  await look(app, 'browse-folder');

  // Job 3: first agent session, then a message.
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).click();
  await app.waitForTimeout(1500);
  await look(app, 'claude-started');
  const composer = app.getByPlaceholder(/^Message/);
  await composer.fill('Add a hello line to README');
  await composer.press('Enter');
  await app.waitForTimeout(2000);
  await look(app, 'message-sent');

  // Job 4: the agent asks before it edits. Find the question and answer it.
  await expect(app.getByText('Do you want to proceed?').first()).toBeVisible({ timeout: 20_000 });
  await look(app, 'approval-asked');
  await app.getByRole('button', { name: /^Decisions/ }).click();
  await look(app, 'decisions-open');
  await app.getByRole('button', { name: /^Allow/ }).click();
  await look(app, 'allow-clicked');
  await app.keyboard.press('Enter'); // the hint under the card asks for it
  await app.waitForTimeout(1500);
  await look(app, 'after-allow-enter');
  await expect(app.getByText('Done: README.md has a hello line.').first()).toBeVisible({ timeout: 15_000 });
  await look(app, 'answered');

  // Job 5: a second session, switch between them, find the first again from the palette.
  await job(app, 'second-session', async () => {
    await app.getByRole('button', { name: 'New session', exact: true }).click();
    await look(app, 'new-tab-popover');
    await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).click();
    await expect(app.getByRole('tablist', { name: 'Sessions' }).getByRole('tab')).toHaveCount(3, { timeout: 8_000 }); // two sessions and the Room tab (ticket 571)
    await look(app, 'two-sessions');
    await app.getByRole('tablist', { name: 'Sessions' }).getByRole('tab').first().click();
    await look(app, 'switched-to-first');
    await app.getByRole('button', { name: /command palette/i }).click();
    await app.keyboard.type('New Claude session');
    await look(app, 'palette-search-name');
    await app.keyboard.press('Escape');
  });

  // Job 6: what did the agent change?
  await job(app, 'diff', async () => {
    await app.getByRole('button', { name: /^Diff/ }).click();
    await look(app, 'diff-open');
    await app.getByText('README.md').last().click();
    await look(app, 'diff-file-clicked');
  });

  // Job 7: import past conversations, then find one by searching.
  await job(app, 'import', async () => {
    const old = path.join(core.home, 'claude-home/projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(old, { recursive: true });
    const line = (type: string, content: unknown, i: number) => JSON.stringify({ type, uuid: `old-${i}`, sessionId: 'old', cwd: repo, timestamp: '2026-10-01T10:00:00Z', message: { role: type, content } });
    fs.writeFileSync(path.join(old, '11111111-2222-4333-8444-555555555555.jsonl'), [line('user', 'Fix the purple login button', 1), line('assistant', [{ type: 'text', text: 'The login button is purple now.' }], 2)].join('\n') + '\n');
    await openSettings(app);
    await look(app, 'settings-again');
    await app.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Onboarding', exact: true }).click();
    await app.getByRole('button', { name: 'Look for conversations' }).click();
    await app.waitForTimeout(1500);
    await look(app, 'import-looked');
    await app.getByRole('button', { name: 'Select all' }).click();
    const imp = app.getByRole('button', { name: /^Import \d/ });
    if (await imp.count()) {
      await imp.first().click();
      await app.waitForTimeout(1500);
      await look(app, 'import-done');
    }
    await app.getByRole('button', { name: 'Close Settings' }).click();
    await app.getByRole('button', { name: /^Search/ }).first().click();
    await look(app, 'search-open');
    await app.keyboard.type('purple');
    await app.waitForTimeout(1500);
    await look(app, 'search-purple');
    await app.getByRole('button', { name: 'Sessions', exact: true }).click().catch(() => app.getByText('Sessions', { exact: true }).first().click());
    await app.waitForTimeout(1500);
    await look(app, 'search-purple-sessions');
  });

  // Job 8: theme, then language to Korean and back.
  await job(app, 'theme-language', async () => {
    await openSettings(app);
    const set = app.getByRole('dialog', { name: 'Settings' });
    await set.getByRole('button', { name: 'Appearance', exact: true }).click();
    await look(app, 'appearance');
    await set.getByText(/^Dark$/).first().click();
    await look(app, 'theme-dark');
    // Onboarding's "Choose your theme" step names where the language is (fixed in 489: it said Appearance had it).
    await set.getByRole('button', { name: 'Onboarding', exact: true }).click();
    await set.getByText('Choose your theme').first().click();
    await expect(set.getByText('The language is under General.')).toBeVisible();
    await set.getByRole('button', { name: 'General', exact: true }).click();
    await look(app, 'general-language');
    const lang = set.getByRole('combobox').first();
    await lang.selectOption({ label: '한국어' }).catch(async () => {
      await lang.click();
      await app.getByText('한국어').first().click();
    });
    await app.waitForTimeout(800);
    await look(app, 'korean');
    // The dialog's name is Korean now ("설정").
    await app.getByRole('dialog').first().getByRole('combobox').first().selectOption({ label: 'English' });
    await app.waitForTimeout(800);
    await look(app, 'english-again');
  });

  // Job 9: sign in a provider account; then signed out.
  await job(app, 'providers', async () => {
    await openSettings(app);
    await look(app, 'settings-now');
    const set = app.getByRole('dialog', { name: 'Settings' });
    await set.getByRole('button', { name: 'Providers', exact: true }).click();
    await look(app, 'providers');
    await set.getByRole('button', { name: /^Check/ }).first().click();
    await app.waitForTimeout(1500);
    // Ticket 494: the fake's own status check fails ("Could not check"); the row says why and offers Sign in beside Check (fixed in 506).
    await look(app, 'claude-check-failed');
    // Signed out: the fake's status check now says so, and the row offers Sign in.
    fs.writeFileSync(path.join(core.home, 'bin/claude'), WALK_CLAUDE().replace('then exit 2; fi', `then echo '{"loggedIn": false}'; exit 1; fi`), { mode: 0o700 });
    await set.getByRole('button', { name: /^Check/ }).first().click();
    await expect(set.getByText('Signed out').first()).toBeVisible({ timeout: 15_000 });
    await look(app, 'claude-signed-out');
    // The row reads Signed out; its account and Sign in are one level down, behind the row's own expand control.
    await set.getByRole('button', { name: /Claude/, expanded: false }).first().click();
    await expect(set.getByRole('button', { name: /Sign in/ }).first()).toBeVisible();
    await look(app, 'claude-row-open');
    await set.getByRole('button', { name: /Sign in/ }).first().click();
    await app.waitForTimeout(1500);
    await look(app, 'sign-in-clicked');
  });

  // Job 10: close a session and get it back.
  await job(app, 'close-undo', async () => {
    await closeDialogs(app);
    await look(app, 'before-close');
    await app.getByRole('tablist').getByRole('tab').first().click({ button: 'right' });
    await look(app, 'tab-menu');
    await app.getByText(/^(Close tab|탭 닫기)$/).first().click();
    await app.waitForTimeout(800);
    await look(app, 'closed');
    await app.keyboard.press('Meta+Shift+KeyT');
    await app.waitForTimeout(1500);
    await look(app, 'reopened');
  });
  expect(stuck, 'every job reached its end').toEqual([]);
});

// Ticket 579 (scorecard F1, F10): the walk of a new user on main with project tabs, the Room tab and plain palette names.
// Not opt-in: each step asserts what a new user needs to see next, and leaves a shot in .scratch/walk-579/.
test('first_use_walk_579: onboarding to a first session, the Room tab, settings by palette, close and reopen', async ({ app, core }) => {
  const dir = path.join(REPO, '.scratch/walk-579');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let k = 0;
  const see = async (name: string) => {
    await app.waitForTimeout(300);
    const id = String(++k).padStart(2, '0');
    await app.screenshot({ path: path.join(dir, `${id}-${name}.png`) });
    fs.appendFileSync(path.join(dir, 'steps.log'), `\n## ${id} ${name}\n${(await app.locator('body').innerText()).replace(/\n{2,}/g, '\n')}\n`);
  };
  fs.writeFileSync(path.join(core.home, 'bin/claude'), WALK_CLAUDE(), { mode: 0o700 });
  const repo = core.project('my-app');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'README.md'), '# my app\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  await app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, repo);

  // 1. No projects: the window opens on Settings > Onboarding and says what the app is.
  await app.goto('/');
  const settings = app.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByText(/runs your coding agents, each in its own tab/)).toBeVisible();
  await see('first-open');

  // 2. Each setup step names itself, says whether it is done, and offers a next action (a button or a switch): none is a dead end.
  const steps = settings.locator('.ob-step');
  const panel = settings.locator('.ob-panel');
  const count = await steps.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i++) {
    const id = await steps.nth(i).getAttribute('data-step');
    await steps.nth(i).click();
    await expect(panel.getByText(/^(Done|Not done)$/)).toBeVisible();
    await expect(panel.locator('button, [role="switch"]').first(), `step ${id} offers an action`).toBeVisible();
    await see(`step-${id}`);
  }

  // 3. Add the first project; the picked folder opens the new-session chooser; Claude starts the first session.
  await settings.locator('.ob-step[data-step="project"]').click();
  await panel.getByRole('button', { name: 'Add project' }).click();
  await see('add-project-dialog');
  await app.getByRole('dialog', { name: 'Add project', exact: true }).getByRole('button', { name: /^Browse folder/ }).click();
  await app.getByRole('dialog', { name: 'New tab' }).getByRole('option', { name: /^Claude/ }).click();
  const composer = app.getByPlaceholder(/^Message/);
  await expect(app.getByText('What should we build in my-app?')).toBeVisible({ timeout: 15_000 });
  await see('first-session');
  await composer.fill('Add a hello line to README');
  await composer.press('Enter');
  await expect(app.getByText('I will add a hello line to README.md.').first()).toBeVisible({ timeout: 20_000 });
  await see('first-answer');

  // 4. The Room tab is there beside the session, and it says what it is for.
  await expect(app.getByRole('tablist', { name: 'Sessions' }).getByRole('tab')).toHaveCount(2); // the session and the Room
  await app.locator('[data-room-tab]').click();
  // Ticket 1041 (c13a5b578) packs the strip: the "+" sits under the resting pointer. A key now cancels a pending hover
  // (Tooltip.tsx), but the strip re-renders under a pointer that does not move and starts the hover again while the palette
  // is open; that tip takes the palette's first Esc (tooltip-esc, by design). A user's pointer moves on; this one leaves.
  await app.mouse.move(700, 400);
  // Ticket 990: the Room draws a wide log and a narrow chat log, CSS shows one (RoomView.tsx); the shown one says it.
  await expect(app.getByText(/In the Room, the agents of this project talk to each other and to you/).filter({ visible: true })).toBeVisible();
  await expect(app.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await see('room-tab');

  // 5. Settings by palette, in plain words: every query lists a row (never "Nothing matched"), and a row opens its page.
  const palette = app.getByRole('dialog', { name: 'Command palette' });
  const ask = async (q: string) => {
    await app.keyboard.press('Meta+KeyK');
    await expect(palette.locator('input')).toBeFocused();
    await app.keyboard.type(q);
  };
  for (const [q, id] of [['settings', 'settings.open'], ['language', 'settings.general.language'], ['dark theme', 'settings.appearance.themeMode'], ['notifications', 'settings.alerts.']] as const) {
    await ask(q);
    await expect(palette.locator(`[data-command^="${id}"]`).first(), `"${q}" finds ${id}`).toBeVisible();
    await see(`palette-${q.replace(' ', '-')}`);
    await app.keyboard.press('Escape');
  }
  await ask('notifications');
  await palette.locator('[data-command^="settings.alerts."]').first().click();
  await expect(settings.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await see('notifications-page');
  const [first] = (core.cli('snapshot', '--json').sessions as { id: string; kind: string }[]).filter((x) => x.kind === 'claude');
  turn(core, first.id);
  // Ticket 582: the onboarding list ends with the first session, done by the answer the agent gave above.
  await settings.getByRole('navigation', { name: 'Settings pages' }).locator('button[data-page="onboarding"]').click();
  await settings.locator('.ob-step[data-step="session"]').click();
  await expect(settings.locator('.ob-step[data-step="session"]')).toHaveAttribute('data-done', 'true');
  await expect(panel.getByRole('status')).toHaveText('Started Claude in my-app.');
  await see('onboarding-first-session-done');
  await settings.getByRole('button', { name: 'Close Settings' }).click();

  // 6. Close and reopen the window: the session and the Room are still there, and Settings does not come back on its own.
  await app.reload();
  await expect(app.getByRole('tablist', { name: 'Sessions' }).getByRole('tab')).toHaveCount(2);
  await expect(settings).toHaveCount(0);
  await see('reopened');

  // Rounds 2 and 3: the step stays done after the answering session is gone. Only App.tsx's `useFirstSessionMark` stores the mark (the
  // Onboarding page does not), so the answer itself sets it, with or without that page open. The core drops a row only when it was
  // stopped before the close (a running one stays as a closed row), so the test core's own agent, by its recorded pid, ends first.
  const rows = () => core.cli('snapshot', '--json').sessions as { id: string; pid: number | null; state: string }[];
  process.kill(rows().find((x) => x.id === first.id)!.pid!);
  await expect.poll(() => rows().find((x) => x.id === first.id)?.state, { timeout: 15_000 }).not.toBe('running');
  core.cli('session', 'close', first.id);
  await expect.poll(() => rows().some((x) => x.id === first.id), { timeout: 15_000, intervals: [500] }).toBe(false);
  await app.keyboard.press('Meta+Comma');
  await settings.locator('.ob-step[data-step="session"]').click();
  await expect(settings.locator('.ob-step[data-step="session"]')).toHaveAttribute('data-done', 'true');
  await expect(panel.getByRole('status')).toHaveText('Your first agent session started.');
});

// Ticket 603 (scorecard F10): the second walk, once in English and once in Korean. Each step asserts what a new user needs to see
// next (a dead end is a screen with no clear next action, an action that fails without saying why, or text that assumes
// knowledge), including three common errors: a picked folder that is gone, an agent program that is not installed, and a folder
// the core may not read. Shots and the visible text of each step go to .scratch/walk-603/<lang>/.
const WALK2 = {
  en: {
    intro: /runs your coding agents, each in its own tab/,
    empty: 'What should we build in my-app?',
    room: /In the Room, the agents of this project talk to each other and to you/,
    queries: { language: 'settings.general.language', 'font size': 'settings.', 'notification sound': 'settings.alerts.', 'new session': '', 'close tab': '', search: '' },
    addProject: 'add project',
    gone: /That file or folder is not there\./,
    locked: /no permission to read/, // chmod is EACCES: the folder's mode, said by name
    noCodex: 'Codex is not installed (codex is not on PATH).',
    failed: 'New Codex session failed: read only',
    answered: 'Started Claude in my-app.',
  },
  ko: {
    intro: /코딩 에이전트를 탭마다 하나씩 실행합니다/,
    empty: 'my-app에서 무엇을 만들까요?',
    room: /대화방은 이 프로젝트의 에이전트끼리, 그리고 나와 이야기하는 곳입니다/, // 5af1c21f5: the ko native read (Q5)
    queries: { 언어: 'settings.general.language', '글꼴 크기': 'settings.', '알림 소리': 'settings.alerts.', '새 세션': '', '탭 닫기': '', 검색: '' },
    addProject: '프로젝트 추가',
    gone: /그 파일이나 폴더가 없습니다/,
    locked: /읽을 권한이 없습니다/,
    noCodex: 'Codex가 설치되어 있지 않습니다(PATH에 codex가 없습니다).', // the particle follows the word since 0ac3cfb7d
    failed: '새 Codex 세션 실패: 읽기 전용',
    answered: /my-app에서 Claude/,
  },
} as const;

for (const lang of ['en', 'ko'] as const) {
  test.describe(`walk 603 ${lang}`, () => {
    test.use({ locale: lang === 'ko' ? 'ko-KR' : 'en-US' });
    test(`first_use_walk_603_${lang}: onboarding, first session, Room, held keys, palette, three errors, reopen`, async ({ app, core }) => {
      const L = WALK2[lang];
      const dir = path.join(REPO, `.scratch/walk-603/${lang}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      let k = 0;
      const see = async (name: string) => {
        await app.waitForTimeout(300);
        const id = String(++k).padStart(2, '0');
        await app.screenshot({ path: path.join(dir, `${id}-${name}.png`) });
        fs.appendFileSync(path.join(dir, 'steps.log'), `\n## ${id} ${name}\n${(await app.locator('body').innerText()).replace(/\n{2,}/g, '\n')}\n`);
      };
      fs.writeFileSync(path.join(core.home, 'bin/claude'), WALK_CLAUDE(), { mode: 0o700 });
      const repo = core.project('my-app');
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      fs.writeFileSync(path.join(repo, 'README.md'), '# my app\n');
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
      const locked = core.project('locked');
      // The folder panel answers these paths in turn (the second is gone by the time it is used); the shell says notifications
      // are not asked yet, as macOS does on a first run (a null answer would hide the step's Ask now button).
      await app.addInitScript((picks) => {
        (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
          invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? (picks.shift() ?? null) : cmd.includes('notification_permission') ? 'default' : null),
        };
      }, [repo, '/no/such/folder', locked]);

      // 1. No projects: Settings > Onboarding says what the app is.
      await app.goto('/');
      const settings = app.getByRole('dialog').first();
      await expect(settings.getByText(L.intro)).toBeVisible();
      await see('first-open');

      // 2. Every step says whether it is done and offers an action.
      const steps = settings.locator('.ob-step');
      const panel = settings.locator('.ob-panel');
      await expect(steps).toHaveCount(9); // ticket 1034: with the assistant step
      for (let i = 0; i < 9; i++) {
        const id = await steps.nth(i).getAttribute('data-step');
        await steps.nth(i).click();
        await expect(panel.locator('.ob-pill')).toBeVisible();
        await expect(panel.locator('button, [role="switch"]').first(), `step ${id} offers an action`).toBeVisible();
        await see(`step-${id}`);
      }

      // 3. Add the project, start Claude, see it answer.
      await settings.locator('.ob-step[data-step="project"]').click();
      await panel.getByRole('button').first().click();
      const addDialog = app.getByRole('dialog', { name: /^(Add project|프로젝트 추가)$/ });
      const newTab = app.getByRole('dialog', { name: /^(New tab|새 탭)$/ });
      await addDialog.getByRole('button').first().click();
      await newTab.getByRole('option', { name: /^Claude/ }).click();
      await expect(app.getByText(L.empty)).toBeVisible({ timeout: 15_000 });
      await see('first-session');
      const composer = app.getByPlaceholder(/Message|메시지/).first();
      await composer.fill('Add a hello line to README');
      await composer.press('Enter');
      await expect(app.getByText('I will add a hello line to README.md.').first()).toBeVisible({ timeout: 20_000 });
      await see('first-answer');

      // 4. The Room tab says what it is for and offers a message box.
      await app.locator('[data-room-tab]').click();
      // Ticket 990: the Room draws a wide log and a narrow chat log, CSS shows one (RoomView.tsx); the shown one says it.
      await expect(app.getByText(L.room).filter({ visible: true })).toBeVisible();
      await see('room-tab');

      // 5. Held keys: ⌘ shows each tab's number, Ctrl each project's.
      await app.keyboard.down('Meta');
      await expect(app.locator('kbd.tkey', { hasText: '⌘1' }).first()).toBeVisible();
      await see('hold-meta');
      await app.keyboard.up('Meta');
      await app.keyboard.down('Control');
      await expect(app.locator('kbd', { hasText: '⌃1' }).first()).toBeVisible();
      await see('hold-ctrl');
      await app.keyboard.up('Control');

      // 6. Three settings and three commands by plain names: each lists a row, never the empty line.
      const palette = app.getByRole('dialog', { name: /^(Command palette|명령 팔레트)$/ });
      for (const [q, id] of Object.entries(L.queries)) {
        await app.keyboard.press('Meta+KeyK');
        await expect(palette.locator('input')).toBeFocused();
        await app.keyboard.type(q);
        // An empty id stands for a command: any row that is not a setting.
        const row = id ? `[data-command^="${id}"]` : '[data-command]:not([data-command^="settings."])';
        await expect(palette.locator(row).first(), `"${q}" lists a row`).toBeVisible();
        await see(`palette-${q.replace(/ /g, '-')}`);
        await app.keyboard.press('Escape');
      }

      // 7. Three errors, each saying why.
      const addFolder = async () => {
        await app.keyboard.press('Meta+KeyK');
        await app.keyboard.type(L.addProject);
        await app.keyboard.press('Enter');
        await addDialog.getByRole('button').first().click();
      };
      // 7a. The picked folder is gone: the core refuses adding it (ticket 702), so the popover says so at the pick.
      await addFolder();
      await expect(newTab.getByText(L.gone)).toBeVisible();
      await see('error-folder-gone');
      await app.keyboard.press('Escape');
      // 7b. Codex is not installed: the cause in the window's language, one fix, no version warning, a plain composer line.
      await app.getByRole('tablist').getByRole('tab').first().click();
      await app.getByRole('button', { name: /^(New session|새 세션)$/ }).first().click();
      await newTab.getByRole('option', { name: /^Codex/ }).click();
      const band = app.locator('.problem-band');
      await expect(band.locator('.cause')).toHaveText(L.noCodex);
      await expect(band.getByRole('button').first()).toBeVisible();
      await expect(app.locator('.chat:not([data-off]) .vbanner')).toHaveCount(0);
      await expect(app.locator('.chat:not([data-off]) .empty.ro')).toHaveCount(0);
      await expect(app.getByText(L.failed)).toBeVisible();
      await see('error-codex-missing');
      // 7c. A folder the core may not read (as macOS refuses a folder it was not granted): refused at the pick (ticket 880).
      fs.chmodSync(locked, 0o000);
      try {
        await addFolder();
        await expect(newTab.getByText(L.locked).first()).toBeVisible();
        await see('error-folder-refused');
      } finally {
        fs.chmodSync(locked, 0o755);
      }
      await app.keyboard.press('Escape');

      // 8. The first-session step is done once the agent's turn ends (the fake sends no hooks; see `turn`).
      const [first] = (core.cli('snapshot', '--json').sessions as { id: string; kind: string; cwd: string }[]).filter((x) => x.kind === 'claude' && x.cwd === repo);
      turn(core, first.id);
      await app.keyboard.press('Meta+Comma');
      await settings.locator('button[data-page="onboarding"]').click();
      await settings.locator('.ob-step[data-step="session"]').click();
      await expect(settings.locator('.ob-step[data-step="session"]')).toHaveAttribute('data-done', 'true');
      await expect(panel.getByRole('status')).toHaveText(L.answered);
      await see('onboarding-done');
      await settings.getByRole('button', { name: /^(Close Settings|설정 닫기)$/ }).click();
      await expect(app.getByRole('dialog', { name: /^(Settings|설정)$/ })).toHaveCount(0);

      // 9. Close and reopen: the sessions and the Room are back, Settings stays closed.
      const tabs = await app.getByRole('tablist').first().getByRole('tab').count();
      await app.reload();
      await expect(app.getByRole('tablist').first().getByRole('tab')).toHaveCount(tabs);
      await expect(app.locator('[data-room-tab]')).toBeVisible();
      await expect(app.getByRole('dialog', { name: /^(Settings|설정)$/ })).toHaveCount(0);
      await see('reopened');
    });
  });
}
