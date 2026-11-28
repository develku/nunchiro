// Ticket 578: the core's fixed refusals that a window request can return say what happened and what to do, in the window's
// language (en and ko here; errors-plain.spec.ts loops all 8 over KNOWN). Each failure is injected on the socket, as
// errors-plain.spec.ts does, except the typed bad path, which the real core refuses.
import type { Locator, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeT, mergeAreas, type Lang } from '../src/i18n';
import * as core578 from '../src/i18n/areas/errors-core';
import * as errors from '../src/i18n/areas/errors';
import * as kit from '../src/i18n/areas/settings-kit';
import * as dialog from '../src/i18n/areas/dialog';
import * as exitWidgets from '../src/i18n/areas/exit-widgets';
import * as accounts from '../src/i18n/areas/settings';
import * as accountAdd from '../src/i18n/areas/account-add';
import { openRow } from './accounts-rows';
import { expect, openWindow, test } from './fixtures';
import { openAt, setup, view } from './fixtures/files/harness';
import { openQuiet } from './tree-seed';
import { startOf } from './start-op';

const TABLES = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { core578, errors, kit, dialog, exitWidgets, accounts, accountAdd });
const words = (lang: Lang) => makeT<string>(lang, lang, TABLES as never);
const LANGS: Lang[] = ['en', 'ko'];
type Match = (r: Record<string, unknown>) => boolean;

/** Refuses the request `match` picks, once per `arm`, with `err` as the core's words. */
async function refuse(app: Page) {
  const armed: { match: Match; err: string }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      const at = r?.request ? armed.findIndex((a) => a.match(r.request)) : -1;
      if (at >= 0) return ws.send(JSON.stringify({ id: r.id, response: { Err: armed.splice(at, 1)[0].err } }));
      server.send(msg);
    });
    server.onMessage((msg) => ws.send(msg));
  });
  return (match: Match, err: string, times = 1) => {
    for (let i = 0; i < times; i++) armed.push({ match, err });
  };
}

async function language(app: Page, lang: Lang) {
  await app.keyboard.press('Meta+Comma');
  await app.locator('button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption(lang);
}

/** The visible words of `box` are `line` (the what and the next step), and the core's own words are not among them. */
async function says(box: Locator, line: string, raw: string) {
  await expect(box).toBeVisible();
  const shown = await box.innerText();
  expect(shown, shown).toContain(line);
  expect(shown.replace(/\s+/g, ' '), shown).not.toContain(raw);
}

for (const lang of LANGS) {
  const t = words(lang);

  test(`errors_core_start_refused_${lang}: four refused starts each say what happened and what to do`, async ({ app, core }) => {
    const arm = await refuse(app);
    await openWindow(app, {}, core);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const cases: [string, string][] = [
      ['project is not a directory', 'err.c.projectFolder'],
      ['conversation is already running', 'err.c.convOpen'],
      ['no conversation to continue', 'err.c.noConversation'],
      ['continuing on another account is for Claude sessions for now', 'err.c.accountCarry'],
    ];
    for (const [raw, key] of cases) {
      arm((r) => !!startOf(r), raw);
      await app.locator('[data-icon="terminal"] button.ai').click();
      const line = t('exitWidgets.notStarted', { error: t(key as never) });
      const toast = app.locator('.toast').filter({ hasText: line });
      await says(toast, line, raw);
      // The next step is a sentence in the toast itself: the second sentence of the catalogue line.
      expect(line.split(/(?<=[.。])\s*/).filter(Boolean).length, line).toBeGreaterThanOrEqual(2);
    }
  });

  test(`errors_core_connection_${lang}: a lost core says so and offers Try again`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    arm((r) => r.op === 'quit_settings' && !r.patch, 'core disconnected', 2);
    await app.locator('button[data-page="git"]').click();
    const lost = app.locator('.err[role="alert"]').first();
    await says(lost, t('settings.err.core'), 'core disconnected');
    await expect(lost.locator('.sretry')).toBeVisible();
  });

  test(`errors_core_worktree_${lang}: a refused branch name says what to change`, async ({ app, core }) => {
    const p = core.project('demo');
    const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    core.shell(p, 'main-shell');
    openQuiet(core);
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const raw = 'invalid branch name';
    arm((r) => r.op === 'worktree' && r.operation === 'create', raw);
    await app.locator('.grp[data-project="demo"] .row.head').hover();
    await app.locator('.grp[data-project="demo"] .wtadd').click();
    await app.getByRole('dialog').getByRole('textbox').first().fill('fix login');
    await app.keyboard.press('Enter');
    const line = t('dialog.worktree.createFailed', { error: t('err.c.branchName') });
    await says(app.locator('.wtoast .wtmsg'), line, raw);
  });

  test(`errors_core_file_${lang}: a path outside the folder and an unreadable file say what to check (real core)`, async ({ app, core }) => {
    const { s } = await setup(app, core, { extra: (dir) => (fs.writeFileSync(path.join(dir, 'locked.txt'), 'x'), fs.chmodSync(path.join(dir, 'locked.txt'), 0o000)) });
    await language(app, lang);
    await app.keyboard.press('Escape');
    for (const [name, key] of [['../outside.txt', 'err.c.pathOutside'], ['locked.txt', 'err.c.notReadable']] as const) {
      await openAt(app, s.id, name);
      const v = view(app, name);
      await expect(v).toHaveAttribute('data-view', 'error');
      const box = v.getByRole('alert');
      await says(box, `${t('err.cantOpen', { name: name.split('/').pop()! })} ${t(key)}`, 'not readable');
      await expect(box.locator('details.err-details')).not.toHaveAttribute('open');
    }
  });

  test(`errors_core_signin_${lang}: a refused sign-in start says why, and Try again is the next step`, async ({ app, core }) => {
    core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.locator('button[data-page="providers"]').click();
    await openRow(app, 'Claude');
    const card = app.locator('[data-agent="claude"]');
    await card.locator('.acct-add button.btn').click();
    arm((r) => r.op === 'account_sign_in', 'at most 4 sign-ins at once');
    await card.locator('.acct-add.open button.btn.p').click();
    const panel = app.locator('.acct-add.acct-remove [role="alert"]');
    await says(panel, t('err.c.signinMax', { count: 4 }), 'at most 4 sign-ins at once');
    // Try again sends the sign-in once more; this time the account is already signing in.
    arm((r) => r.op === 'account_sign_in', '"Account 2" is already signing in');
    await app.locator('.acct-add.acct-remove button.btn.p').click();
    await says(panel, t('err.c.signinRunning'), '"Account 2" is already signing in');
  });

  test(`errors_core_close_note_${lang}: a refused Close session is a note that says the session ended`, async ({ app, core }) => {
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const s = core.shell(core.project('demo'), 'job', '/bin/sh', '-c', 'read x; exit 0');
    await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
    core.cli('session', 'send-text', s.id, 'x\r');
    await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.id)?.state).toBe('exited');
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    arm((r) => r.op === 'close', 'session is not running');
    await app.keyboard.press('Meta+KeyK');
    await app.locator('[data-command="session.close"]').click();
    const note = app.locator('.pane-status .pane-note');
    await expect(note).toHaveText(t('exitWidgets.notClosed', { error: `${t('err.session')} ${t('err.session.todo')}` }));
  });
}

// Each fixed core reason (the exact text in crates/nunchiro-core) maps to its own line, in all 8 languages: never the
// generic "That did not work.", never the core's words in the message. The file and line name where the core writes it.
const ALL_LANGS: Lang[] = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'];
const REASONS: [string, string][] = [
  ['only an ended session can be restarted', 'restartLive'], // sessions.rs:15419
  ['start this shell again by hand', 'restartShell'], // :15423
  ['this session ran in a worktree; start it again there by hand', 'restartWorktree'], // :15441
  ['no resumable session of this agent', 'noConversation'], // :15599
  ['no conversation to continue', 'noConversation'], // :7407
  ['conversation is already running', 'convOpen'], // :15605
  ['continuing on another account is for Claude sessions for now', 'accountCarry'], // :7401
  ['project is not a directory', 'projectFolder'], // :7345
  ['no such path', 'noPath'], // projects/mod.rs:170
  ['model switch in progress', 'modelBusy'], // :2251
  ['a model switch is already running for this session', 'modelBusy'], // :6359
  ['a mode change is already running for this session', 'modelBusy'], // :6591
  ['the agent is working; switch when it is idle', 'agentBusy'], // :6371
  ['a prompt is being submitted; switch when it is idle', 'agentBusy'], // :6364
  ["Codex's input box is not on the screen; switch when it shows", 'notReady'], // :6385
  ['Claude is not at its prompt', 'notReady'], // :6482
  ['agent is not at its composer; mode not changed', 'notReady'], // :6599
  ["bypass permissions is turned off by Claude's settings (disableBypassPermissionsMode)", 'bypassOff'], // :6618
  ['unknown model', 'modelUnknown'], // :5750
  ['unknown effort for this model', 'modelUnknown'], // :5766
  ['this close can no longer be undone', 'undoLate'], // :4246
  ['this session was resumed meanwhile; it can no longer be undone', 'undoLate'], // :4243
  ['Side chat is temporary; open a new side chat', 'sideChat'], // :15415
  ['worktree has unsaved work', 'wtDirty'], // :14761
  ['invalid branch name', 'branchName'], // :14833
  ['branch feature/x no longer exists', 'branchGone'], // :14849
  ['worktree removal in progress', 'wtRemoving'], // :4484
  ['managed worktree is missing', 'wtMissing'], // :15067
  ['not a worktree of this project', 'wtMissing'], // :15007
  ['at most 64 accounts', 'accountMax'], // accounts.rs:561
  ['at most 4 sign-ins at once', 'signinMax'], // account_signin.rs:194
  ['"Account 2" is already signing in', 'signinRunning'], // account_signin.rs:214
  ['that does not look like a sign-in code', 'codeBad'], // account_signin.rs:275
  ['a code was already sent; start the sign-in again', 'codeGone'], // :285
  ['the login no longer reads a code', 'codeGone'], // :287
  ['account name must be 1-64 visible characters (192 bytes), spaces allowed', 'labelBad'], // accounts.rs:823
  ['a registered account folder is never discarded', 'accountKeep'], // accounts.rs:711
  ["the built-in account is the agent's own config and is never removed", 'accountKeep'], // accounts.rs:990
  ['path not allowed', 'pathOutside'], // files/confine.rs:46
  ['outside root', 'pathOutside'], // :70
  ['not readable', 'notReadable'], // :78
  ['not a regular file or folder', 'notReadable'], // :81
  ['not a PNG, JPEG, GIF or WebP image', 'imageKind'], // images.rs:120
  ['not a GitHub pull request link', 'prLink'], // pr/mod.rs:712
  ['icon is over 256 KiB', 'iconBad'], // projects/mod.rs:264
  ['icon must be a PNG, JPEG or SVG image', 'iconBad'], // :270
  ['the editor did not open (exit status: 1)', 'editorFailed'], // :219
  ['unknown project', 'projectGone'], // :262
  ['machine alias already listed', 'machineName'], // sessions.rs:684
  ['Stop its sessions first', 'machineSessions'], // :720
  ['agents.toml is busy', 'agentsFile'], // acp/add.rs:88
  ['agents.toml changed', 'agentsFile'], // :160
  ['server name: letters, digits, - and _ only', 'nameChars'], // extensions.rs:453
  ['skill name: letters, digits, - and _ only', 'nameChars'], // :886
  ['text is larger than 256 KiB; nothing was saved', 'textBig'], // :829
  ['core did not answer', 'coreSlow'], // web/src/chat/pending.ts:101
  ['the core started nothing', 'startNothing'], // web/src/chat/useComposerSend.ts:391
  ['already answered', 'answered'], // web/src/chat/pending.ts:95
  ['the file changed on disk since it was opened; nothing was saved', 'fileChanged'], // ticket 820: file_write
  ['not a text file; it is not edited here', 'notText'],
  ['file is over 512 KiB; it is not edited here', 'editBig'],
];

test('errors_core_known_all_languages: each core reason reads as its own line in all 8 languages, never generic or raw', async () => {
  const { explainError } = await import('../src/errors');
  const bad: string[] = [];
  for (const lang of ALL_LANGS) {
    const t = words(lang);
    for (const [raw, key] of REASONS) {
      const got = explainError(t as never, raw);
      const count = /at most (\d+)/.exec(raw)?.[1];
      const want = t(`err.c.${key}` as never, count ? { count } : undefined);
      if (!got.known) bad.push(`${lang}: not known: ${raw}`);
      else if (got.what !== want) bad.push(`${lang}: ${raw} -> ${got.what}`);
      else if (lang !== 'en' && got.what.includes(raw)) bad.push(`${lang}: raw text in the line: ${raw}`);
      else if (lang !== 'en' && got.what === words('en')(`err.c.${key}` as never, count ? { count } : undefined)) bad.push(`${lang}: English text: ${raw}`);
      if (got.details !== raw) bad.push(`${lang}: details lost: ${raw}`);
    }
  }
  expect(bad).toEqual([]);
  expect(new Set(REASONS.map(([, k]) => k)).size).toBe(Object.keys(core578.en).length);
});
