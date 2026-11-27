// Ticket 476: an error says in plain words what happened and what to do, in the window's language; the core's or the OS's
// own text shows only under a closed Details. Real core; each failure is injected on the socket, as settings-kit does.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { makeT, mergeAreas, type Lang } from '../src/i18n';
import * as errors from '../src/i18n/areas/errors';
import * as errorsCore from '../src/i18n/areas/errors-core';
import * as errorsGaps from '../src/i18n/areas/errors-gaps';
import * as errorsGroups from '../src/i18n/areas/errors-groups';
import * as kit from '../src/i18n/areas/settings-kit';
import * as dialog from '../src/i18n/areas/dialog';
import * as about from '../src/i18n/areas/settings-about';
import * as exitWidgets from '../src/i18n/areas/exit-widgets';
import * as tree from '../src/i18n/areas/tree';
import * as providersManage from '../src/i18n/areas/providers-manage';
import * as agents from '../src/i18n/areas/agents';
import * as leftovers from '../src/i18n/areas/english-leftovers';
import * as own from '../src/i18n/areas/own-sentences';
import * as koreanA11y from '../src/i18n/areas/korean-a11y';
import * as machines from '../src/i18n/areas/machines'; // machines.linkBad (ticket 1122)
import * as leader from '../src/i18n/areas/leader'; // lead.freshStuck and lead.freshStuckHanded (ticket 1122)
import { openRow } from './accounts-rows';
import { expect, grantClipboard, openWindow, REPO, test } from './fixtures';
import { enable, freePort, phone } from './web-access-shared';
import { openAt, setup, view } from './fixtures/files/harness';
import { openQuiet } from './tree-seed';
import { panel, search, setup as searchSetup } from './fixtures/search/harness';

const TABLES = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { errors, errorsCore, errorsGaps, errorsGroups, kit, dialog, about, exitWidgets, tree, providersManage, agents, leftovers, own });
const words = (lang: Lang) => makeT<string>(lang, lang, TABLES as never);
const LANGS: Lang[] = ['en', 'ko'];
const ALL_LANGS: Lang[] = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'];
const RAW = /^(Error:|ENOENT|.*os error|exit status|fatal:)/;
const out = path.join(REPO, '.scratch/shots/errors-476');
const shot = (l: Locator | Page, name: string) => (fs.mkdirSync(out, { recursive: true }), l.screenshot({ path: path.join(out, `${name}.png`) }));

/** Refuses the request `match` picks, once per `arm`, with `err` as the core's words. */
async function refuse(app: Page) {
  const armed: { match: (r: Record<string, unknown>) => boolean; err: string }[] = [];
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
  return (match: (r: Record<string, unknown>) => boolean, err: string, times = 1) => {
    for (let i = 0; i < times; i++) armed.push({ match, err });
  };
}

async function language(app: Page, lang: Lang) {
  await app.keyboard.press('Meta+Comma');
  await app.locator('button[data-page="general"]').click();
  await app.locator('[data-setting="language"]').selectOption(lang);
}

/** The failure reads `line`; the raw text is under a closed Details, not in the visible words; nothing visible starts raw. */
async function plain(box: Locator, line: string, raw: string) {
  await expect(box).toBeVisible();
  const shown = await box.innerText();
  expect(shown.startsWith(line), shown).toBe(true);
  expect(shown).not.toContain(raw);
  const details = box.locator('details.err-details');
  await expect(details).not.toHaveAttribute('open');
  await expect(details).toContainText(raw);
  await details.locator('summary').click();
  await expect(box).toContainText(raw);
  await details.locator('summary').click();
}

// Ticket 480: also the surfaces 480 converted that carry no role of their own (toasts, diff states, update and widget lines,
// the board and layout lines). Its `title` and closed Details are not visible words.
const SURFACES = '[role="alert"], [role="status"], .wtoast, .pane-status, .toast, .dstate, .upd-line, .uw-act, .bmsg, .lnote, .lerr, .emsg, .perm-err, .af-lib-msg, .sstat';
async function noRawVisible(app: Page) {
  const shown = await app.locator(SURFACES).evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean));
  for (const text of shown) expect(text, text).not.toMatch(RAW);
}

for (const lang of LANGS) {
  test(`errors_plain_settings_${lang}: a lost connection and a failed save say what to do, the core's words under Details`, async ({ app, core }) => {
    const t = words(lang);
    core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    // Both Git rows read the settings: both are refused.
    arm((r) => r.op === 'quit_settings' && !r.patch, 'core disconnected', 2);
    await app.locator('button[data-page="git"]').click();
    const lost = app.locator('.err[role="alert"]').first();
    await plain(lost, t('settings.err.core'), 'core disconnected');
    await noRawVisible(app);
    if (lang === 'en') await shot(lost, 'after-core-disconnected');
    // One Try again may reload both rows: click the first one left until none is.
    const retries = app.locator('.err[role="alert"] .sretry');
    await expect(async () => {
      if (await retries.count()) await retries.first().click({ timeout: 1000 });
      expect(await retries.count()).toBe(0);
    }).toPass();
    await expect(app.locator('.err[role="alert"]')).toHaveCount(0);

    const raw = 'settings.toml: Resource busy (os error 16)';
    arm((r) => r.op === 'quit_settings' && !!r.patch, raw);
    const field = app.locator('[data-setting="worktreeRoot"]');
    await field.fill('../elsewhere');
    await field.blur();
    const failed = app.locator('.err[role="alert"]');
    await plain(failed, `${t('err.failed')} ${t('err.failed.todo')}`, raw);
    await noRawVisible(app);
    if (lang === 'en') await shot(failed, 'after-settings-save');
  });

  test(`errors_plain_git_${lang}: a failing git command in a worktree create says so plainly, git's words under Details`, async ({ app, core }) => {
    const t = words(lang);
    const p = core.project('demo');
    execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one']);
    core.shell(p, 'main-shell');
    openQuiet(core);
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const raw = 'git worktree: fatal: invalid reference: nope'; // process.rs git_run: "git <subcommand>: <stderr>"
    arm((r) => r.op === 'worktree' && r.operation === 'create', raw);
    await app.locator('.grp[data-project="demo"] .row.head').hover();
    await app.locator('.grp[data-project="demo"] .wtadd').click();
    const d = app.getByRole('dialog');
    await d.getByRole('textbox').first().fill('fix-login');
    await app.keyboard.press('Enter');
    const toast = app.locator('.wtoast .wtmsg');
    await plain(toast, t('dialog.worktree.createFailed', { error: `${t('err.git')} ${t('err.git.todo')}` }), raw);
    await noRawVisible(app);
    if (lang === 'en') await shot(app.locator('.wtoast'), 'after-git-failed');
  });

  test(`errors_plain_file_${lang}: a missing file says it is gone and what to check, the core's words under Details`, async ({ app, core }) => {
    const t = words(lang);
    const { s } = await setup(app, core);
    await language(app, lang);
    await app.keyboard.press('Escape');
    await openAt(app, s.id, 'gone.txt');
    const v = view(app, 'gone.txt');
    await expect(v).toHaveAttribute('data-view', 'error');
    const box = v.getByRole('alert');
    const raw = (await box.locator('details').textContent())!.replace(t('err.details'), '');
    expect(raw).not.toBe('');
    await plain(box, `${t('err.cantOpen', { name: 'gone.txt' })} ${t('err.missing')} ${t('err.missing.todo')}`, raw);
    await noRawVisible(app);
    if (lang === 'en') await shot(box, 'after-missing-file');
  });
  test(`errors_plain_note_${lang}: a failed command's status-bar note stays, copies its reason on click and closes with ×`, async ({ app, core, browserName }) => {
    const t = words(lang);
    await grantClipboard(app);
    const s = core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.keyboard.press('Escape');
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    const raw = 'holder busy';
    arm((r) => r.op === 'scrollback_edit', raw);
    await app.getByRole('button', { name: /palette|팔레트/ }).first().click();
    await app.getByRole('combobox').first().fill('$EDITOR');
    await app.keyboard.press('Enter');
    const note = app.locator('.pane-status .pane-note');
    await expect(note).toHaveText(t('err.note.scrollback', { error: `${t('err.failed')} ${t('err.failed.tip')}` }));
    await expect(note).toHaveAttribute('data-tip', raw);
    await noRawVisible(app);
    expect(core.opened()).toBe(''); // ticket 800: the refused op never reached the core's `open -t`
    // Past the 4 s a plain note fades after: a failure stays.
    await app.waitForTimeout(4500);
    await expect(note).toBeVisible();
    if (lang === 'en') await shot(app.locator('.pane-status'), 'after-note');
    await note.click();
    await expect(note).toHaveText(t('about.copied'));
    if (browserName === 'chromium') expect(await app.evaluate(() => navigator.clipboard.readText())).toBe(raw);
    await app.locator('.pane-status .pane-note-x').click();
    await expect(note).toHaveCount(0);
  });
}

test('errors_plain_core_reply: the known core replies map to their lines, anything else to the generic one', async () => {
  const { explainError, tipError, knownOrRaw } = await import('../src/errors');
  const t = words('en') as Parameters<typeof explainError>[0];
  const what = (raw: string) => explainError(t, new Error(raw)).what;
  expect(what('core disconnected')).toBe(t('settings.err.core'));
  expect(what('git worktree: fatal: invalid reference: x')).toBe(t('err.git'));
  expect(what('git status: not a git repository')).toBe(t('err.git'));
  // Not a git command's failure (sessions.rs): no "fix the repository".
  expect(what('git providers require unlocked transport dispatch')).toBe(t('err.failed'));
  expect(what('/p/a.txt: No such file or directory (os error 2)')).toBe(t('err.missing'));
  expect(what('not found')).toBe(t('err.missing'));
  expect(what('root unavailable')).toBe(t('err.missing')); // ticket 480: a search in a removed folder
  expect(what('claude --version: No such file or directory (os error 2)')).toBe(t('err.agentMissing'));
  expect(what('codex is not signed in for this account')).toBe(t('err.signin'));
  expect(what('close live worktree sessions first')).toBe(t('err.liveSessions'));
  // Ticket 534: fixed core refusals that say what to do, with the name they carry, in English and Korean.
  expect(explainError(t, 'account "work" is in use; close its sessions first')).toMatchObject({ what: 'The account work is in use.', todo: t('err.accountInUse.todo'), known: true });
  expect(explainError(t, 'an extension named release-notes already exists')).toMatchObject({ what: 'An extension named release-notes already exists.', todo: t('err.nameTaken.todo') });
  expect(explainError(t, 'duplicate group name Site')).toMatchObject({ what: 'A group named Site already exists.', todo: 'Choose another name.' });
  const ko = words('ko') as Parameters<typeof explainError>[0];
  expect(explainError(ko, 'duplicate group name Site')).toMatchObject({ what: 'Site라는 그룹이 이미 있습니다.', todo: '다른 이름을 고르세요.', details: 'duplicate group name Site' });
  // Lane 534's NOTE: Rust's `{:?}` escapes a quote and a backslash in the label; the line shows the label itself.
  expect(explainError(t, 'account "a\\"b\\\\c" is in use; close its sessions first').what).toBe('The account a"b\\c is in use.');
  // Ticket 536: the rest of 534's list the window can show, each in English and Korean, the core's words kept for Details.
  const core536: [string, string, string, string, string][] = [
    ['answer the waiting decision first', 'A decision is waiting in this session.', 'Answer it, then switch the model.', '이 세션에서 결정이 기다리고 있습니다.', '결정에 답한 뒤 모델을 바꾸세요.'],
    ['approve the agent first', 'This agent is not approved.', 'Approve it in Settings, then try again.', '이 에이전트는 승인되지 않았습니다.', '설정에서 승인한 뒤 다시 시도하세요.'],
    ['start a session in a project folder first', 'Start a session in a project folder first; the login tab opens there.', '', '먼저 프로젝트 폴더에서 세션을 시작하세요. 해당 위치에서 로그인 탭이 열립니다.', ''],
    ['maximum 32 retained PTYs; close an exited session first', '32 sessions are open, the maximum number.', 'Close a session that has ended, then try again.', '세션이 최대 개수인 32개 열려 있습니다.', '끝난 세션을 하나 닫은 뒤 다시 시도하세요.'],
    ['off: the PR view uses your gh; turn on live PR status first', 'Live PR status is off.', 'Turn it on in Settings, then try again.', '실시간 PR 상태가 꺼져 있습니다.', '설정에서 켠 뒤 다시 시도하세요.'],
    ['a pairing from this address is already waiting; answer it on the Mac first', 'A pairing from this address is already waiting.', 'Allow or refuse them on the Mac, then try again.', '이 주소에서 보낸 페어링이 이미 기다리고 있습니다.', 'Mac에서 허용하거나 거절한 뒤 다시 시도하세요.'],
    ['too many pairings waiting; answer them on the Mac first', 'Too many pairings are waiting.', 'Allow or refuse them on the Mac, then try again.', '기다리는 페어링이 너무 많습니다.', 'Mac에서 허용하거나 거절한 뒤 다시 시도하세요.'],
    ['too many refused pairings from this address; try later', 'Too many pairings from this address were refused.', 'Wait up to an hour, then try again.', '이 주소에서 보낸 페어링이 너무 많이 거절되었습니다.', '최대 1시간 기다린 뒤 다시 시도하세요.'],
    ['browser-devices.json is unreadable; fix or remove it first', 'The list of paired browsers (browser-devices.json) cannot be read.', 'Fix or remove that file, then try again.', '페어링된 브라우저 목록(browser-devices.json)을 읽을 수 없습니다.', '그 파일을 고치거나 제거한 뒤 다시 시도하세요.'],
    ['too many groups', 'There are 256 project groups, the maximum number.', 'Remove a group, then try again.', '프로젝트 그룹이 최대 개수인 256개입니다.', '그룹을 하나 제거한 뒤 다시 시도하세요.'],
    ['too many grouped projects', '4096 projects are in groups, the maximum number.', 'Take a project out of its group, then try again.', '그룹에 든 프로젝트가 최대 개수인 4096개입니다.', '프로젝트 하나를 그룹에서 뺀 뒤 다시 시도하세요.'],
    ['session holder did not answer; the agent still runs', 'The session did not answer. The agent is still running.', 'Try again in a moment.', '세션이 응답하지 않았습니다. 에이전트는 아직 실행 중입니다.', '잠시 뒤 다시 시도하세요.'],
    ['codex did not answer in time', 'Codex did not answer in time.', 'Try again in a moment.', 'Codex가 제시간에 응답하지 않았습니다.', '잠시 뒤 다시 시도하세요.'],
    ['too many themes loading; try again', 'Too many themes are loading.', 'Try again in a moment.', '불러오는 테마가 너무 많습니다.', '잠시 뒤 다시 시도하세요.'],
  ];
  const koT = words('ko') as Parameters<typeof explainError>[0];
  for (const [raw, en, enTodo, koWhat, koTodo] of core536) {
    expect(explainError(t, new Error(raw)), raw).toEqual({ what: en, todo: enTodo, details: raw, known: true });
    expect(explainError(koT, raw), raw).toEqual({ what: koWhat, todo: koTodo, details: raw, known: true });
  }
  // Anchored on the whole sentence: a longer reply that only contains one is not taken for it.
  expect(explainError(t, 'too many groups in tree.toml').known).toBe(false);
  // A one-line place with no Details (pairing page, theme line) shows a known line, else the raw words.
  expect(knownOrRaw(t, 'codex did not answer in time')).toBe('Codex did not answer in time. Try again in a moment.');
  expect(knownOrRaw(t, 'exit status 3')).toBe('exit status 3');
  expect(explainError(t, 'exit status 3')).toEqual({ what: t('err.failed'), todo: t('err.failed.todo'), details: 'exit status 3', known: false });
  // A tooltip has nothing below it: the raw words follow in brackets instead of "Details below.".
  expect(tipError(t, 'exit status 3')).toBe(`${t('err.failed')} (exit status 3)`);
  expect(tipError(t, 'not found')).toBe(`${t('err.missing')} ${t('err.missing.todo')}`);
  // A group line (ticket 601) is shared by many reasons and says "Details below": the tooltip keeps the reason (web widget act, ticket 730).
  expect(tipError(t, 'no session named nobody')).toBe(`${t('err.h.actRefused')} (no session named nobody)`);
});


// Ticket 480: the places 476 did not reach. A diff list (Diff and the Artifacts widget) and a refused board or file read
// say the plain line; the raw words never lead.
test('errors_plain_rest_lines: the diff list, the patch and the layout lines lead with plain words in each language', async () => {
  const { listState } = await import('../src/diff/state');
  const { plainError, tipError } = await import('../src/errors');
  const rest = await import('../src/i18n/areas/errors-rest');
  const diffArea = await import('../src/i18n/areas/chat-diff');
  for (const lang of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as Lang[]) {
    const t = makeT<string>(lang, lang, mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { errors, kit, rest, diffArea }) as never) as Parameters<typeof plainError>[0];
    const lost = listState('s1', null, 'core disconnected', t)!;
    expect(lost).toContain(t('settings.err.core'));
    expect(lost).not.toContain('core disconnected');
    const odd = listState('s1', null, 'exit status 3', t)!;
    expect(odd).toContain(t('err.failed'));
    expect(odd).not.toMatch(RAW);
    expect(odd).not.toContain('exit status 3');
    // Every new line exists in every language (no English fallback).
    for (const k of Object.keys(rest.en)) expect((rest as unknown as Record<string, Record<string, string>>)[lang === 'zh-Hans' ? 'zhHans' : lang === 'zh-Hant' ? 'zhHant' : lang][k], `${lang} ${k}`).toBeTruthy();
    // A one-line place (layout strip, toast) keeps an unknown reason readable in brackets after the plain line.
    expect(t('err.layoutTrees', { n: 2, error: tipError(t, 'core disconnected') })).not.toContain('core disconnected');
  }
});

// Ticket 480: one browser case per kind of place 480 converted. SHOT_TAG=before on the base takes the same shots (dark).
const out480 = path.join(REPO, '.scratch/shots/errors-480');
const shot480 = async (app: Page, l: Locator, name: string) => {
  await app.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  fs.mkdirSync(out480, { recursive: true });
  await l.screenshot({ path: path.join(out480, `${process.env.SHOT_TAG ?? 'after'}-${name}.png`) });
};
const unknown = (t: ReturnType<typeof words>) => `${t('err.failed')} ${t('err.failed.todo')}`;

for (const lang of LANGS) {
  test(`errors_plain_inline_${lang}: a refused permission change is the plain line, the core's words under Details`, async ({ app, core }) => {
    const t = words(lang);
    fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
    core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.locator('button[data-page="providers"]').click();
    await openRow(app, 'Claude');
    const pick = app.getByRole('combobox', { name: `${t('providersManage.permission')} · Claude` });
    await expect(pick).toHaveValue('full-access');
    // Not "<name>.json: <fault>": since ticket 1122 that is a known file fault (ledger/package.rs, a task package file).
    const raw = 'settings.toml: Resource busy (os error 16)';
    arm((r) => r.op === 'agent_permission_set', raw);
    await pick.selectOption('ask');
    const box = app.locator('#s-accounts [role="alert"]').filter({ hasText: raw });
    await expect(box).toBeVisible();
    if (lang === 'en') await shot480(app, box, 'inline-permission');
    await plain(box, unknown(t), raw);
    await noRawVisible(app);
  });

  // Ticket 536: a known core refusal (sessions.rs:4189, a stale holder) says its own line in the same place.
  for (const [name, raw, reason] of [
    ['', 'sessions: Resource busy (os error 16)', unknown],
    ['_holder', 'session holder did not answer; the agent still runs', (t: ReturnType<typeof words>) => `${t('err.holderSilent')} ${t('err.later.todo')}`],
  ] as const)
  test(`errors_plain_catalogue${name}_${lang}: a refused close in Remove from tree is its catalogue line with the plain reason, raw under Details`, async ({ app, core }) => {
    const t = words(lang);
    const p = core.project('alpha');
    const { id } = core.shell(p, 'done', '/usr/bin/true');
    await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((s) => s.id === id)?.state).toBe('exited');
    openQuiet(core);
    const arm = await refuse(app);
    await openWindow(app, {}, core);
    await language(app, lang);
    await app.keyboard.press('Escape');
    await app.locator('.grp[data-project="alpha"] .head .n').click({ button: 'right' });
    await app.locator('[data-command="project.remove"]').click();
    const d = app.getByRole('alertdialog');
    arm((r) => r.op === 'close', raw);
    await d.locator('.rmacts button').last().click();
    const box = d.locator('[role="alert"]').filter({ hasText: raw });
    await expect(box).toBeVisible();
    if (lang === 'en' && !name) await shot480(app, d, 'catalogue-remove');
    await plain(box, t('tree.project.removeFailed', { closed: 0, total: 1, error: reason(t) }), raw);
    await noRawVisible(app);
  });

  test(`errors_plain_toast_${lang}: a Terminal icon start that fails is a toast in plain words, no raw text`, async ({ app, core }) => {
    const t = words(lang);
    const arm = await refuse(app);
    await openWindow(app, {}, core);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const raw = 'sessions.toml: No space left on device (os error 28)';
    arm((r) => r.op === 'start', raw);
    await app.locator('[data-icon="terminal"] button.ai').click();
    const toast = app.locator('.toast');
    await expect(toast).toBeVisible();
    if (lang === 'en') await shot480(app, toast, 'toast-terminal');
    await expect(toast).toContainText(t('exitWidgets.notStarted', { error: t('settings.err.full') }));
    await expect(toast).not.toContainText('os error');
    await noRawVisible(app);
  });

  test(`errors_plain_note_close_${lang}: a refused Close session is a status-bar note, the raw reason its tooltip`, async ({ app, core }) => {
    const t = words(lang);
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    await app.keyboard.press('Escape');
    const s = core.shell(core.project('demo'), 'job', '/bin/sh', '-c', 'read x; exit 0');
    await expect(app.locator(`.tab[data-tab="${s.id}"]`)).toBeVisible();
    core.cli('session', 'send-text', s.id, 'x\r');
    await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; state: string }[]).find((x) => x.id === s.id)?.state).toBe('exited');
    await app.locator(`.tab[data-tab="${s.id}"]`).click();
    const raw = 'holder busy';
    arm((r) => r.op === 'close', raw);
    await app.keyboard.press('Meta+KeyK');
    await app.locator('[data-command="session.close"]').click();
    const note = app.locator('.pane-status .pane-note');
    // The shot waits for the status line's words, not the note's own element (the base has none), so it runs on both.
    await expect(app.locator('.pane-status')).toContainText(t('exitWidgets.notClosed', { error: '' }).trim());
    if (lang === 'en') await shot480(app, app.locator('.pane-status'), 'note-close');
    await expect(note).toHaveText(t('exitWidgets.notClosed', { error: `${t('err.failed')} ${t('err.failed.tip')}` }));
    await expect(note).toHaveAttribute('data-tip', raw);
    await noRawVisible(app);
  });

  test(`errors_plain_tooltip_${lang}: a row that cannot read its setting says so plainly, the raw reason its tooltip`, async ({ app, core }) => {
    const t = words(lang);
    core.shell(core.project('demo'), 'alpha');
    const arm = await refuse(app);
    await openWindow(app);
    await language(app, lang);
    const raw = 'settings.json: Permission denied (os error 13)';
    // Every read on the Git page is refused (its rows and the credits switch; more arms than reads is harmless here).
    arm((r) => r.op === 'quit_settings' && !r.patch, raw, 8);
    await app.locator('button[data-page="git"]').click();
    const line = app.locator(`span[role="alert"][title="${raw}"]`);
    const section = app.locator('[data-setting="stripAgentCredits"]').locator('xpath=ancestor::section[1]');
    await expect(section.locator('[role="alert"]')).toBeVisible(); // also on the base, for its shot
    if (lang === 'en') await shot480(app, section, 'tooltip-credits');
    await expect(line).toHaveText(t('settings.err.denied'));
    await noRawVisible(app);
  });
}

// Ticket 551 (scorecard F9): every line of the plain-error mapping exists in all 8 languages, and the 536 list reads plainly in each.
test('errors_plain_known_all_languages: each KNOWN line has its own words and its placeholder in all 8 languages', async () => {
  const { KNOWN, explainError } = await import('../src/errors');
  const schedule = await import('../src/i18n/areas/schedule');
  const levels = await import('../src/i18n/areas/levels'); // level.customOn: the line of team.rs's custom-model refusal
  const gitActions = await import('../src/i18n/areas/git-actions'); // gitActions.err.*: the Diff panel's Push refusals
  const tables = mergeAreas({ en: {}, ko: {}, ja: {}, 'zh-Hans': {}, 'zh-Hant': {}, es: {}, fr: {}, pt: {} }, { errors, errorsCore, errorsGaps, errorsGroups, kit, dialog, about, exitWidgets, tree, providersManage, agents, schedule, levels, own, koreanA11y, machines, leader, gitActions }) as unknown as Record<string, Record<string, string>>;
  expect(KNOWN.length).toBeGreaterThan(30);
  const missing: string[] = [];
  for (const lang of ALL_LANGS) {
    for (const [re, what, todo] of KNOWN) {
      const keys = [what, todo].filter((k): k is NonNullable<typeof k> => !!k);
      for (const k of keys) {
        const text = tables[lang]?.[k];
        // owner 11-21 (ticket 1035): a new line is English only until the one pass before the release (errors-core-reasons.spec.ts).
        if (!text) lang === 'en' && missing.push(`${lang} ${k}: no text`);
        else if (lang !== 'en' && text === tables.en[k] && !/^[A-Za-z0-9 .,:;'"{}()\-]*$/.test(text)) missing.push(`${lang} ${k}: English text`);
        else if (k === what) for (const g of re.source.matchAll(/\(\?<(\w+)>/g)) if (!text.includes(`{${g[1] === 'quoted' ? 'name' : g[1]}}`)) missing.push(`${lang} ${k}: no {${g[1]}}`);
      }
    }
  }
  expect(missing).toEqual([]);
  // The unknown line and its Details label are also in every language.
  for (const lang of ALL_LANGS) {
    const t = words(lang) as Parameters<typeof explainError>[0];
    const odd = explainError(t, 'exit status 3');
    expect(odd.known).toBe(false);
    expect(odd.what, lang).not.toBe('');
    expect(t('err.details'), lang).not.toBe('');
    // A known core refusal says its own line, never the raw text, in each language.
    const busy = explainError(t, 'search busy: try again in a moment');
    expect(busy, lang).toMatchObject({ known: true, details: 'search busy: try again in a moment' });
    expect(busy.what, lang).not.toContain('search busy');
    expect(busy.todo, lang).not.toBe('');
  }
});

// Ticket 548 (closed by 551): the two lines Search and the layout showed in English only, in every language. `badReply` is the
// reply with no match list or page; `stripGone` is the notice after the last Answer strip goes (layout.spec.ts has it in English).
test('errors_plain_leftovers_all_languages: search.badReply and stripGone are written out in all 8 languages', async () => {
  const lines = (lang: Lang) => {
    const t = words(lang) as (k: never, a?: Record<string, string>) => string;
    return { bad: t('leftovers.search.badReply' as never), gone: t('leftovers.stripGone' as never, { signals: t('leftovers.signalsLeft' as never) }) };
  };
  const en = lines('en');
  expect(en.bad).toBe('unexpected search reply from the background service');
  for (const lang of ALL_LANGS) {
    const l = lines(lang);
    expect(l.bad, lang).not.toContain('{');
    expect(l.gone, lang).not.toContain('{');
    if (lang === 'en') continue;
    expect(l.bad, lang).not.toBe(en.bad);
    expect(l.gone, lang).not.toBe(en.gone);
  }
});

// Ticket 551: a search whose reply is wrong or refused reads plainly in the window's language; no raw sentence, no English
// in Korean.
for (const lang of LANGS) {
  test(`errors_plain_search_reply_${lang}: a reply with no match list and a busy search say plain words`, async ({ app, core }) => {
    const t = words(lang);
    const { wire } = await searchSetup(app, core);
    await language(app, lang);
    await app.keyboard.press('Escape');
    // Ticket 991 C22: the workspace is inert until Settings has closed; a fill before that types nowhere.
    await expect(app.locator('.win > .body')).not.toHaveAttribute('inert');
    wire.hook = (req) => JSON.stringify({ id: req.id, response: { Ok: { type: 'matches' } } });
    await search(app, 'needle');
    await expect(panel(app).getByRole('alert')).toHaveText(t('leftovers.search.badReply' as never));
    wire.hook = (req) => JSON.stringify({ id: req.id, response: { Err: 'search busy: try again in a moment' } });
    await search(app, 'needle two');
    await expect(panel(app).getByRole('alert')).toHaveText(`${t('err.searchBusy')} ${t('err.later.todo')}`);
    await expect(panel(app).getByRole('alert')).not.toContainText('search busy');
  });
}

// Ticket 551 (scorecard F9): a scan of the window's source. No UI file reads an error's `.message` or `String(e)` itself:
// `rawError(e)` (the raw text, for Details and a tooltip) and `lineError`, `plainError`, `ErrorLine` (the plain words) in
// errors.tsx are the only ways, so a new place cannot show the core's or the OS's text without going through the mapping.
test('errors_plain_scan: no UI code reads an error message or String(error) directly', async () => {
  const root = path.join(REPO, 'web/src');
  const ALLOWED: Record<string, string> = {
    'errors.tsx': 'rawError itself',
    'api.ts': 'the client retries a busy refusal; the text is never shown',
    'CrashScreen.tsx': 'the crash screen puts the message, stack and component stack on the clipboard for a bug report',
  };
  const BAD = [
    [/\b(e|err|error|x|reason)\.message\b/, 'reads .message of an error: use rawError(e), and show lineError(t, e) or ErrorLine'],
    [/\bString\((e|err|error|x)\)/, 'String(error): use rawError(e)'],
    [/\bknown \? plainError\([^)]*\) : (?!t\()/, 'shows the raw text when the failure is not known: use lineError(t, e)'],
    // Scorecard D9: a raw id or path where a name exists.
    [/\bsession_id\.slice\(/, 'an id prefix shown as a name: use sessionName(session)'],
    [/(?<!\$)\{(session|s)\.(cwd|project)\}/, 'a raw path shown as text: use basename(path) or the project name'],
  ] as const;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) f.name !== 'i18n' && walk(full);
      else if (/\.tsx?$/.test(f.name) && !ALLOWED[path.relative(root, full)] && !ALLOWED[f.name]) {
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          // Ticket 553: the full path as a hover title beside its basename (PermissionNeeded) is the one allowed raw path.
          const code = line.replace(/\/\/.*$/, '').replace(/(?<![\w-])title=\{session\.cwd\}/, '');
          for (const [re, why] of BAD) if (re.test(code)) found.push(`${path.relative(root, full)}:${i + 1}: ${why}`);
        });
      }
    }
  };
  walk(root);
  expect(found).toEqual([]);
});

// Ticket 565: the window's own sentences of areas/own-sentences.ts come from the catalogue. Each English sentence (its longest
// fixed part of 14 characters or more) must not come back as a literal in the source, and an answer's label is never a literal.
test('own_sentences_scan: no UI code writes one of the catalogue sentences of ticket 565 as a literal', async () => {
  const own = await import('../src/i18n/areas/own-sentences');
  const src = path.join(REPO, 'web/src');
  const fragments = Object.entries(own.en).flatMap(([key, text]) => {
    const part = text.split(/\{\w+\}/).sort((a, b) => b.length - a.length)[0].trim();
    return part.length >= 14 ? [[key, part] as const] : [];
  });
  expect(fragments.length).toBeGreaterThan(30);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) f.name !== 'i18n' && walk(full);
      else if (/\.tsx?$/.test(f.name)) {
        const text = fs.readFileSync(full, 'utf8');
        // PermissionNeeded.tsx matches the core's own refusal wording (sessions.rs `refused_start`); it never shows it as its sentence.
        for (const [key, part] of fragments) if (text.includes(part) && f.name !== 'PermissionNeeded.tsx') found.push(`${path.relative(src, full)}: "${part}" is ${key}`);
      }
    }
  };
  walk(src);
  expect(fs.readFileSync(path.join(src, 'queue/answer.ts'), 'utf8')).not.toMatch(/label: '/);
  expect(found).toEqual([]);
});

// Ticket 559 (F3, found by the 552 sweep): a pairing request the page cannot read says one plain line; the browser's own words
// ("Unexpected token '<'...", "Failed to fetch") only sit under the closed Details line.
for (const [name, fail] of [
  ['an answer that is not JSON', (r: import('@playwright/test').Route) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>proxy error</html>' })],
  ['a dropped connection', (r: import('@playwright/test').Route) => r.abort('connectionrefused')],
] as const)
  test(`errors_plain_pairing_unreachable_559: ${name} shows a plain line, not the browser's message`, async ({ app, browser }) => {
    const port = await freePort();
    await enable(app, port);
    const { page } = await phone(browser, `http://127.0.0.1:${port}/`);
    await page.route('**/pair', (r) => (r.request().method() === 'POST' ? fail(r) : r.fallback()));
    await page.getByRole('button', { name: 'Pair' }).click();
    const alert = page.getByRole('alert');
    await expect(alert.locator('p')).toHaveText('Could not reach Nunchiro. Check that your Mac is on and its network is up, then try again.');
    await expect(alert.locator('p')).not.toContainText(/token|JSON|fetch|Failed|Unexpected/i);
    await alert.getByText('Details').click();
    await expect(alert).toContainText(name === 'a dropped connection' ? /fetch|Load failed/i : /JSON|token|expected pattern/i); // WebKit words a bad JSON answer as "did not match the expected pattern"
    await page.context().close();
  });
