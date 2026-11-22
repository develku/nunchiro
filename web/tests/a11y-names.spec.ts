// Ticket 412: screen readers hear words, not data. Rows and the notify chip are rendered node side and read through the
// browser's accessibility tree (getByRole names); the decision card (it imports CSS, which the node runner cannot load)
// is read in the real window against a real core and a fake agent.
import { expect, test, type Page } from '@playwright/test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { openWindow, test as app } from './fixtures';
import { icon, sidebar } from './d5b';
import { fakes, gitRepo, QUESTION, show as screen } from './decision-rows-seed';
import { NotifyLevel } from '../src/queue/notify';
import { questionText, rowState } from '../src/tree';
import { WtRow } from '../src/tree/RowIcon';
import type { Decision, Session } from '../src/types';
import { EN, makeT } from './i18n-tables';

const t = makeT('en', 'en');
const NOW = 10_000_000;
const show = (page: Page, el: ReactElement) => page.setContent(`<main>${renderToStaticMarkup(el)}</main>`);

const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    kind: 'claude',
    project: '/p',
    cwd: '/p',
    label: 'fix-a',
    state: 'running',
    agent_version: null,
    untested: false,
    pid: 1,
    pending: [],
    attention: { working: false, waiting: true, stale: false, failed: false, last_activity: NOW },
    ...over,
  }) as Session;
const ask = (kind: Decision['kind'], text: string, over: Partial<Decision> = {}): Decision => ({
  id: 'd1',
  session_id: 's1',
  scope: '',
  kind,
  text,
  choices: [],
  observed_at: NOW - 120_000,
  actionable: true,
  ...over,
});
const row = (d: Decision, over: Partial<Session> = {}) => {
  const s = session({ ...over, pending: [d] });
  return createElement(WtRow, { name: 'fix-a', state: rowState({ path: '/p/wt', name: 'fix-a', sessions: [s] }, [s], undefined, NOW, undefined, t), t });
};
const JSON_Q = JSON.stringify({ questions: [{ question: 'Which branch should the fix go on?', options: [{ label: 'main' }, { label: 'dev' }] }] });

test('question_row_name: a question row is named by the question text, never its JSON', async ({ page }) => {
  await show(page, row(ask('question', JSON_Q)));
  await expect(page.getByRole('button', { name: 'fix-a, Question · Which branch should the fix go on?. Claude · asked 2 min ago', exact: true })).toBeVisible();
  // A malformed payload says only "Question": no braces, no quotes, no keys.
  await show(page, row(ask('question', '{"questions":[{"question":')));
  await expect(page.getByRole('button', { name: 'fix-a, Question. Claude · asked 2 min ago', exact: true })).toBeVisible();
  // A payload that parses but holds no question text says the same.
  await show(page, row(ask('question', JSON.stringify({ questions: [{ options: ['a'] }] }))));
  await expect(page.getByRole('button', { name: 'fix-a, Question. Claude · asked 2 min ago', exact: true })).toBeVisible();
});

// Sixth look, Home S3: a lead's question read from the screen starts at the terminal's rule, and the row was named
// "Question · ─────…". The name carries the question, or (a prompt with no question mark) the row's own line.
const RULE = '─'.repeat(60);
const SCREEN_Q = `❯ ask me\n${RULE}\n ☐ Test runner\n\nWhich test runner should the Builders\nuse for this project?\n\n❯ 1. Standard library tests\n  2. pytest\n${RULE}\n  3. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
test('question_row_name_from_screen: a question read from the screen is named by its question, never by the terminal rule', async ({ page }) => {
  await show(page, row(ask('question', SCREEN_Q)));
  await expect(page.getByRole('button', { name: 'fix-a, Question · Which test runner should the Builders use for this project?. Claude · asked 2 min ago', exact: true })).toBeVisible();
  expect(questionText(`${RULE}\n ☐ Name\n\n Pick a name for the file\n\n❯ 1. alpha\n  2. beta`)).toBe('☐ Name · Pick a name for the file');
  expect(questionText(`${RULE}\n${RULE}`)).toBe('');
});

test('question_text_model: first question, trimmed and cut; screen text keeps its first line; JSON never leaks', () => {
  expect(questionText(JSON_Q)).toBe('Which branch should the fix go on?');
  expect(questionText(JSON.stringify({ question: '  Ship it?\nmore  ' }))).toBe('Ship it?');
  expect(questionText('Pick one\n1. a\n2. b')).toBe('Pick one');
  // Look 11-17 N20: Codex's async question names it `title`.
  expect(questionText(JSON.stringify({ questions: [{ title: 'Which name?', options: ['alpha', 'beta'] }] }))).toBe('Which name?');
  const long = questionText(JSON.stringify({ questions: [{ question: 'word '.repeat(60) }] }));
  expect(long.length).toBeLessThanOrEqual(120);
  expect(long.endsWith('…')).toBe(true);
  for (const bad of ['{', '{"questions":[', '[1,2]', '{"questions":[{"question":3}]}', '{}']) expect(questionText(bad), bad).toBe('');
});

test('skip_badge_named: the "!" badge names what it means, and the row it sits in says it too', async ({ page }) => {
  await show(page, row(ask('question', JSON_Q), { permission_mode: 'bypass permissions' } as Partial<Session>));
  const button = page.getByRole('button', { name: /^fix-a, Question · Which branch/ });
  await expect(button).toHaveAccessibleName(/Bypass permissions on$/);
  await expect(button.locator('.skipm')).toHaveAccessibleName('Bypass permissions on');
});

// Ticket 991: a Codex session started in YOLO mode wears the same mark; it is named by the one word for full access (look v9 B N-S3-1: Claude's),
// the one its composer chip and Settings > Providers use. Any other Codex mode, and an ended session, has no mark.
test('skip_badge_named_codex: a Codex YOLO row has the "!" badge, named "Bypass permissions" in the badge, its tooltip and the row', async ({ page }) => {
  await show(page, row(ask('question', JSON_Q), { kind: 'codex', permission_mode: 'full-access' } as Partial<Session>));
  const button = page.getByRole('button', { name: /^fix-a, Question · Which branch/ });
  await expect(button).toHaveAccessibleName(/Bypass permissions$/);
  await expect(button).toHaveAttribute('data-skip', 'true');
  const mark = button.locator('.skipm');
  await expect(mark).toHaveText('!');
  await expect(mark).toHaveAccessibleName('Bypass permissions');
  await expect(mark).toHaveAttribute('title', 'Bypass permissions');
  expect(await button.locator('.tip').innerText()).toContain('Bypass permissions');
  // f51512194 (ko native read): Claude's own Korean word for the mode (`mode.bypass permissions`), no longer "YOLO 모드".
  expect(makeT('ko', 'ko')('agents.new.permYolo')).toBe('권한 우회');
  for (const over of [{ kind: 'codex', permission_mode: 'ask' }, { kind: 'codex', permission_mode: 'auto' }, { kind: 'codex', permission_mode: 'own' }, { kind: 'codex', permission_mode: 'full-access', state: 'exited' }, { kind: 'claude', permission_mode: 'full-access' }]) {
    await show(page, row(ask('question', JSON_Q), over as Partial<Session>));
    await expect(page.locator('.skipm'), JSON.stringify(over)).toHaveCount(0);
    await expect(page.locator('[data-skip]'), JSON.stringify(over)).toHaveCount(0);
  }
});

app('disabled_reason_described: a disabled option carries its tooltip reason as its accessible description', async ({ app: page, core }) => {
  // An option the window never sends (one that persists to the agent's config) is listed, not sent, with the reason.
  // Ticket 991 B4/B5 (e5929c1b): it is text now, not a disabled button, and a folder-trust dialog lists no choices at all;
  // the persistent option of a question is the case left, and its text still carries the reason.
  fakes(core);
  const a = core.agent(gitRepo(core, 'repo'), 'wt-a', 'go-a', true);
  await openWindow(page);
  screen(a.cwd, 'go-a', QUESTION);
  await expect(page.locator(`.q[data-line="${a.id}"]`)).toBeVisible({ timeout: 8000 });
  await icon(page, 'right', 'Decisions').click();
  const opt = sidebar(page, 'right').locator('[data-act="option"]', { hasText: '3 Always pick red from now on' });
  await expect(opt).toHaveCount(1);
  await expect(opt).not.toHaveRole('button');
  await expect(opt).toHaveAccessibleDescription(EN['decisions.optionTerminal']);
});

test('notify_chip_level: the notify chip is named with its session and its level', async ({ page }) => {
  for (const [level, word] of [['all', 'notify: all'], ['waiting', 'notify: waiting only'], ['muted', 'notify: muted']] as const) {
    await show(page, createElement(NotifyLevel, { session: 's1', label: 'fix-a', level, onChange: () => {}, t }));
    await expect(page.getByRole('button', { name: `Notifications for fix-a, ${word}`, exact: true })).toBeVisible();
  }
  // Every shipped language has the words.
  for (const lang of ['ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'pt'] as const)
    expect(makeT(lang, lang)('chat.notify.chip', { name: 'x', level: 'y' }), lang).not.toBe(EN['chat.notify.chip'].replace('{name}', 'x').replace('{level}', 'y'));
});
