// Evidence-only capture of the unticked owner backlog at one main revision. Never part of the gate.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type Core, REPO, agentsZone, expect, openWindow, test } from './fixtures';
import { append, chat, openChat, rec, test as chatTest } from './fixtures/chat/harness';
import { defaultBars } from '../src/layout/bars';
import { icon, startEdit } from './d5b';
import { riskPatches } from './fixtures/fid-tree';
import { openQuiet } from './tree-seed';
import { repo, show, trading, worktree, patchSnapshots, type Scheme } from './visual/compare';

// Every capture records the revision it was shot at; a lane may pin a different one explicitly.
const BASE = (process.env.OWNER_CHECK_1030_BASE ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()).trim();
const OUT = path.join(REPO, '.scratch/owner-check-1030');
const ROOT = REPO;
const KO = `${ROOT}/.scratch/v2-drafts/ko`;
const REVIEW = `${ROOT}/.scratch/review-1028`;
const SCHEMES = ['light', 'dark'] as const;
test.skip(({ browserName }) => process.env.OWNER_CHECK_1030 !== '1' || browserName !== 'chromium', 'OWNER_CHECK_1030=1, Chromium only');
test.skip(!fs.existsSync(`${ROOT}/.scratch/v2-drafts/ko`), 'approved mockup frames absent from this checkout (.scratch/v2-drafts/ko)');
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'default' });

const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
test.beforeAll(() => {
  // A later evidence-only commit is allowed; the product tree and every existing fixture must equal BASE.
  expect(git('merge-base', 'HEAD', BASE)).toBe(BASE);
  expect(git('diff', BASE, '--', 'web/src', 'crates', 'app', 'web/tests', ':!web/tests/owner-check-1030-shots.spec.ts')).toBe('');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'one-sha.json'), JSON.stringify({ base: BASE, candidate: git('rev-parse', 'HEAD'), date: new Date().toISOString(), viewport: [1440, 900] }, null, 2));
});

async function reference(app: Page, file: string, scheme: Scheme) {
  expect(path.isAbsolute(file)).toBe(true);
  expect(fs.existsSync(file), `Missing approved mockup: ${file}`).toBe(true);
  // Separate context: the app boot token/init scripts must never reach a mockup.
  const context = await app.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
  const m = await context.newPage();
  await m.goto(`file://${file}`);
  await m.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
  // The original D5b ends in an unclosed script; execute its own text without editing the approved file.
  if (file.endsWith('layout-d5b.html')) await m.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = document.querySelector('script')!.textContent!;
    document.body.append(script);
  });
  await m.evaluate(() => document.fonts.ready);
  return m;
}
async function pair(app: Page, target: Locator, file: string, selector: string, name: string, prepare?: (m: Page) => Promise<void>) {
  for (const scheme of SCHEMES) {
    await app.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect(app.locator('html')).toHaveAttribute('data-theme', scheme);
    await expect(target.first()).toBeVisible();
    const m = await reference(app, file, scheme);
    try {
      await prepare?.(m);
      if (file.endsWith('frame-ko-e.html')) await m.addStyleTag({ content: '.mock{display:none!important}' });
      const mock = m.locator(selector.replace('{scheme}', scheme === 'light' ? 'lt' : 'dk')).first();
      await expect(mock).toBeVisible();
      await app.mouse.move(1400, 880);
      if (name === 'fork') {
        await target.hover();
        const action = target.getByRole('button', { name: 'Fork from here', exact: true });
        await expect(action.locator('..')).toHaveCSS('opacity', '1');
        const a = (await target.boundingBox())!, b = (await action.locator('..').boundingBox())!;
        await app.screenshot({ path: path.join(OUT, `${name}-app-${scheme}.png`), clip: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) }, animations: 'disabled' });
      } else await target.first().screenshot({ path: path.join(OUT, `${name}-app-${scheme}.png`), animations: 'disabled' });
      await mock.screenshot({ path: path.join(OUT, `${name}-mock-${scheme}.png`), animations: 'disabled' });
      fs.writeFileSync(path.join(OUT, `${name}-${scheme}.json`), JSON.stringify({ base: BASE, file, selector, app: await target.first().innerText(), mockup: await mock.innerText() }, null, 2));
    } finally { await m.context().close(); }
  }
}
const settings = async (app: Page, name: string) => {
  await app.getByRole('button', { name: 'Settings', exact: true }).click();
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
};
const mk = (app: Page, value: string) => app.evaluate((v) => (0, eval)(`state(${JSON.stringify(v)})`), value);

test('tree: same-data folded and expanded rows (8e, CF3, tokens, residue, pass64)', async ({ app, core }) => {
  test.setTimeout(90_000);
  const group = await trading(app, core, 'light', true);
  await pair(app, group.locator('> .row.ghead'), `${KO}/v2-8a-a-folds.html`, '.pane.{scheme} .proj.grp', 'tree-folded');
});

test('layout A/B: edit library and nested subviews', async ({ app, core }) => {
  const p = core.project('nunchiro');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/codex'), path.join(core.home, 'bin/codex'));
  core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'ux-fix-2');
  core.cli('session', 'start', '--kind', 'codex', '--project', p, '--label', 'layout-d5');
  core.cli('session', 'close', core.shell(p, 'docs-1028h').id);
  core.shell(core.project('lumen'), 'backtest-v3');
  openQuiet(core, 'nunchiro', 'lumen');
  const bars = { ...defaultBars(), nest: { [p]: ['agents', 'files'] }, open: { [`${p}::agents`]: true } };
  await app.addInitScript((b) => localStorage.setItem('nunchiro.settings.v1', JSON.stringify({ bars: b })), bars);
  await patchSnapshots(app, { 'ux-fix-2': { waiting: 'permission', text: 'cargo test --workspace' }, 'layout-d5': { working: true }, 'backtest-v3': { working: true } });
  await openWindow(app);
  await pair(app, app.locator('aside.sbar[data-side="left"]'), `${KO}/layout-d5b.html`, '#sbL', 'nested');
  await startEdit(app);
  await pair(app, app.locator('body'), `${KO}/layout-d5b.html`, '#mw', 'layout', async (m) => { await m.locator('#lay').click(); });
});

chatTest('UXFIX and CHROME: wide Keys, sessions and startup, whole frame', async ({ page: app, chatCore: core }) => {
  const p = core.project('nunchiro');
  const session = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'ux-fix-2', '--model', 'opus').session as { id: string; cwd: string; agent_session_id: string };
  const file = core.transcriptPath(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const sample = await reference(app, `${KO}/frame-ko-e.html`, 'light');
  await sample.locator('.img').first().screenshot({ path: path.join(p, 'tree-after.png') });
  await sample.context().close();
  append(file,
    rec.user('트리 행 높이를 30px로 바꾸고 결정 줄을 hiderows r6처럼 맞춰 줘. 끝나면 테스트 돌려.'),
    rec.assistant('먼저 현재 트리 스타일을 읽어 보겠습니다.'),
    rec.use('r1', 'Read', { file_path: `${p}/web/src/tree/tree.css` }), rec.result('r1', 'css'),
    rec.use('s1', 'Grep', { pattern: 'row: 22' }), rec.result('s1', '3 matches'),
    rec.assistant('settings.ts의 compact 밀도가 22px를 고정하고 있어서, 기본값을 comfortable(30px)로 옮기고 compact는 옵션으로 남기겠습니다.'),
    rec.assistant('```ts\nexport const DENSITY = {\n  comfortable: { row: 30, name: 13 }, // ko/ 기본\n  compact: { row: 22, name: 12 },\n};\n```'),
    rec.edit('e1', `${p}/web/src/settings.ts`, [...Array.from({ length: 9 }, (_, i) => `-old ${i}`), ...Array.from({ length: 42 }, (_, i) => `+new ${i}`)]),
    rec.assistant('바뀐 트리 모습입니다.\n\n![tree-after.png](tree-after.png)\n\n이제 cargo test --workspace를 돌리려면 권한이 필요합니다. (결정은 트리 줄과 결정 위젯에서)'));
  await openChat(app, session.id);
  hook(core, session.id, 'UserPromptSubmit');
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane] .xterm-screen')).toBeVisible();
  await pair(app, app.locator('body'), `${KO}/frame-ko-e.html`, '#mw', 'frame');
  await settings(app, 'Keyboard');
  await pair(app, app.locator('.settings'), `${KO}/frame-ko-e.html`, '.view[data-view="set"]', 'keys', async (m) => { await m.locator('[data-v="set"]').first().click(); });
});

test('worktree create, start-agent control, pass65 (8a,8f)', async ({ app, core }) => {
  repo(core, 'nunchiro');
  core.shell(core.project('nunchiro'), 'main');
  openQuiet(core);
  await openWindow(app);
  await app.locator('.grp[data-project="nunchiro"] button.n').click({ button: 'right' });
  await app.getByRole('menuitem', { name: /New worktree/ }).click();
  const dialog = app.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().fill('fix login redirect');
  await pair(app, dialog, `${KO}/v2-8a-compare-r3.html`, 'section[aria-labelledby="h-d1"] .dlg', 'new');
  await dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await dialog.getByRole('checkbox', { name: /Start/ }).check();
  await expect(dialog.getByRole('button', { name: 'Create and start' })).toBeVisible();
  await pair(app, dialog, `${KO}/v2-8a-compare-r3.html`, 'section[aria-labelledby="h-d1"] .dlg', 'new-start');
});

type Listed = { path: string; branch: string };
const create = (core: Core, p: string, branch: string) => (core.cli('worktree', 'create', '--project', p, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
/** A worktree whose agent session ended: its folder holds no running session. */
const ended = (core: Core, w: Listed) => {
  const s = core.cli('worktree', 'open', '--path', w.path, '--no-focus').session as { id: string };
  core.cli('session', 'close', s.id);
  return s.id;
};
/** "Tidy": 2 merged (PR chip patched), 1 folder gone, 2 needing a decision, over three projects as in the mockup. */
async function tidyPanel(app: Page, core: Core, scheme: Scheme) {
  const merged = new Set<string>();
  const projects = ['nunchiro', 'lumen', 'tide'].map((n) => repo(core, n));
  const [n, k, s] = projects;
  merged.add(ended(core, create(core, n, 'v2-9a-groups')));
  merged.add(ended(core, create(core, k, 'lcfollow')));
  const gone = create(core, s, 'v2-old');
  execFileSync('git', ['-C', s, 'worktree', 'remove', '--force', '--', gone.path]);
  for (const [p, b] of [[n, 'v2-undo'], [k, 'rehfix']] as const) {
    const w = create(core, p, b);
    for (const f of ['one.txt', 'two.txt', 'three.txt']) fs.writeFileSync(path.join(w.path, f), 'x');
  }
  for (const p of projects) core.shell(p, 'main');
  openQuiet(core);
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const chips = new Map<number, string>();
    ws.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r?.request?.op === 'pr_chip' && merged.has(r.request.id)) chips.set(r.id, (core.cli('snapshot', '--json').sessions as { id: string; project: string }[]).find((s) => s.id === r.request.id)?.project.split('/').pop() ?? '');
      server.send(msg);
    });
    server.onMessage((msg) => {
      const r = typeof msg === 'string' ? JSON.parse(msg) : null;
      if (r && chips.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: `https://github.com/acme/app/pull/${r.id && chips.get(r.id) === 'lumen' ? 18 : 52}`, at: null } } } }));
      ws.send(msg);
    });
  });
  await show(app, scheme);
  await expect(app.locator('.grp[data-project="nunchiro"]')).toBeVisible();
  await expect(async () => {
    await app.keyboard.press('Meta+KeyK');
    await expect(app.locator('.palette input')).toBeFocused({ timeout: 3000 });
  }).toPass({ timeout: 15_000 });
  await app.keyboard.type('worktree.tidy');
  await app.keyboard.press('Enter');
  const d = app.getByRole('dialog', { name: /^Tidy/ });
  await expect(d).toBeVisible();
  const all = d.getByRole('button', { name: 'All projects' });
  if ((await all.count()) && (await all.getAttribute('aria-pressed')) === 'false') await all.click();
  await expect(d.getByRole('listitem')).toHaveCount(5);
  // The click on "All projects" took the panel's own focus: Cancel gets it back by keyboard, so its ring shows (focus-visible).
  await d.getByRole('button', { name: 'Cancel' }).focus();
  await app.keyboard.press('Shift+Tab');
  await app.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.mouse.move(1400, 880);
  return d;
}

test('Tidy (8g, pass65, dark colours): approved five rows over three projects', async ({ app, core }) => {
  test.setTimeout(90_000);
  const d = await tidyPanel(app, core, 'light');
  await pair(app, d, `${KO}/v2-8a-compare-r3.html`, 'section[aria-labelledby="h-d3"] .dlg[aria-label^="정리 ·"]', 'tidy');
});

test('CHAT-MENUS and permission chip: project files, commands, real mode footer', async ({ app, core }) => {
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode'), path.join(core.home, 'bin/claude'));
  const p = repo(core, 'nunchiro');
  // The mockup's @tree sample lists three files; files_search matches content, so each of the three names "tree" in its text.
  for (const [file, content] of Object.entries({ '.claude/commands/code-review.md': '# review', '.claude/skills/tdd/SKILL.md': '# tdd', 'web/src/tree/tree.css': '.tree {}', 'web/src/tree/Tree.tsx': 'export const tree = 1;', 'web/tests/tree-rows.spec.ts': '// tree rows' })) {
    fs.mkdirSync(path.dirname(path.join(p, file)), { recursive: true });
    fs.writeFileSync(path.join(p, file), content);
  }
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', p, '--label', 'layout-b', '--model', 'opus', '--effort', 'high').session as { id: string };
  await openWindow(app);
  await app.locator(`.tab[data-tab="${s.id}"]`).click();
  const input = app.locator('.composer textarea');
  await input.fill('/');
  await expect(app.getByRole('listbox', { name: 'Commands and skills' })).toBeVisible();
  await pair(app, app.getByRole('listbox', { name: 'Commands and skills' }), `${REVIEW}/claude-feel-2.html`, '.pop', 'slash', async (m) => { await mk(m, 'slash'); });
  await input.fill('@tree');
  await expect(app.getByRole('listbox', { name: 'Files', exact: true }).getByRole('option', { name: /tree\.css/ })).toBeVisible();
  await pair(app, app.getByRole('listbox', { name: 'Files', exact: true }), `${REVIEW}/claude-feel-2.html`, '.pop', 'at', async (m) => { await mk(m, 'at'); });
  await input.fill('');
  const permission = app.getByRole('button', { name: 'Permission mode' });
  await expect(permission).toHaveText(/^Manual/);
  await permission.click();
  await expect(permission).toHaveText(/^Accept edits/);
  await input.focus();
  await pair(app, app.locator('.composer'), `${REVIEW}/claude-feel-2.html`, '.dock', 'mode', async (m) => { await mk(m, 'idle'); });
});

test('HINTS2: alphabet, kind keys and preview', async ({ app, core }) => {
  core.shell(core.project('nunchiro'), 'ux-fix-2');
  await openWindow(app);
  await settings(app, 'Keyboard');
  await app.getByRole('button', { name: 'Options ↓' }).click(); // needs 192 (ticket 250): hints are the Keyboard page's last part, reached from the Options link
  await expect(app.getByRole('textbox', { name: 'Hint alphabet' })).toHaveValue('asdfjklghewruiopqtyvcmnxzb1234567890'); // ticket 389: the new default letters
  await app.getByRole('textbox', { name: 'Hint alphabet' }).fill("qyou=ciae-',.;/12345");
  await pair(app, app.getByRole('region', { name: 'Hints', exact: true }), `${REVIEW}/hints2-mockup.html`, '.cols', 'hints');
});

test('SPLITS: visible split chooser and temporary Diff pane', async ({ app, core }) => {
  const p = repo(core, 'nunchiro');
  fs.mkdirSync(path.join(p, 'web/src/tree'), { recursive: true });
  fs.writeFileSync(path.join(p, 'web/src/settings.ts'), 'row: 22,\n');
  fs.writeFileSync(path.join(p, 'web/src/tree/tree.css'), '.row{height:22px;border-radius:3px}\n');
  execFileSync('git', ['-C', p, 'add', '.']);
  execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'sample before']);
  core.agent(p, 'ux-fix-2', 'x');
  fs.writeFileSync(path.join(p, 'web/src/settings.ts'), 'comfortable: { row: 30, name: 13 },\ncompact: { row: 22, name: 12 },\n');
  fs.writeFileSync(path.join(p, 'web/src/tree/tree.css'), '.row{height:30px;border-radius:5px}\n');
  await openWindow(app);
  await app.keyboard.press('Meta+KeyD');
  const chooser = app.getByRole('listbox', { name: 'Open in this split' });
  await expect(chooser).toBeVisible();
  await chooser.getByRole('option', { name: /^Diff/ }).click();
  await expect(app.getByRole('button', { name: 'Close split' })).toBeVisible();
  await expect(app.locator('[data-split-id]')).toContainText('web/src/settings.ts');
  await pair(app, app.locator('[data-split-id]'), `${KO}/frame-ko-e.html`, '#tmp', 'split', async (m) => { await m.locator('[data-mk2="diff"]').click(); });
  // Terminal icon is also a visible labelled way into the per-session side pane.
  await app.getByRole('button', { name: 'Close split' }).click();
  await icon(app, 'right', 'Terminal').click();
  await expect(app.locator('[data-side-pane]')).toBeVisible();
});

test('FIDELITY menus: model/agent picker', async ({ app, core }) => {
  for (const kind of ['claude', 'codex']) fs.copyFileSync(path.join(REPO, `crates/nunchiro/tests/fixtures/${kind}-picker`), path.join(core.home, `bin/${kind}`));
  core.cli('session', 'start', '--kind', 'claude', '--project', core.project('nunchiro'), '--label', 'claude', '--model', 'opus');
  await openWindow(app);
  await app.locator('[data-picker="model"]').click();
  await expect(app.locator('[data-menu="model"]')).toBeVisible();
  await pair(app, app.locator('[data-menu="model"]'), `${KO}/round2.html`, '#s02 .menu', 'menu');
});

const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
function hook(core: Core, id: string, event: 'UserPromptSubmit' | 'Stop') {
  const reply = JSON.parse(execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 }));
  if (!reply.Ok) throw new Error(`hook refused: ${JSON.stringify(reply)}`);
}


test('CHAT-STOP: same working turn, queued text and Stop', async ({ app, core }) => {
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode'), path.join(core.home, 'bin/claude'));
  const s = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('nunchiro'), '--label', 'layout-b', '--model', 'opus', '--effort', 'high').session as { id: string };
  await openWindow(app);
  const permission = app.getByRole('button', { name: 'Permission mode' });
  await expect(permission).toHaveText(/^Manual/);
  await permission.click();
  await expect(permission).toHaveText(/^Accept edits/);
  hook(core, s.id, 'UserPromptSubmit');
  await expect(app.locator('.composer .send')).toHaveAccessibleName('Stop');
  await app.locator('.composer textarea').fill('프로젝트 행은 건드리지 마');
  await app.locator('.composer textarea').press('Enter');
  await expect(app.locator('.composer .qlist')).toBeVisible();
  await pair(app, app.locator('.composer'), `${REVIEW}/claude-feel-2.html`, '.dock', 'stop', async (m) => { await mk(m, 'running'); });
});

test('Undo: clear two done sessions, live status action', async ({ app, core }) => {
  agentsZone(core);
  const p = core.project('nunchiro');
  for (const name of ['ux-fix-2', 'layout-d5']) core.cli('session', 'close', core.shell(p, name).id);
  core.shell(p, 'docs-1028h');
  await app.clock.install();
  await openWindow(app);
  await app.getByRole('button', { name: 'Clear done' }).click();
  const line = app.locator('footer.status .undoline');
  await expect(line).toContainText('Cleared 2 done sessions');
  await pair(app, line, `${ROOT}/.scratch/v2-drafts/05-context-undo.html`, '#o5a .status', 'undo');
});

chatTest('Fork: approved message hover buttons', async ({ page, chatCore }) => {
  const s = chatCore.chat('fork-source');
  append(s.file, rec.user('Please split the queue module.'), rec.assistant('먼저 파일 경계를 정리할게요.'));
  await openChat(page, s.id);
  const row = chat(page, s.id).locator('[data-menu="chat"]').filter({ hasText: 'Please split the queue module.' });
  await row.hover();
  await expect(row.getByRole('button', { name: 'Fork from here', exact: true })).toBeVisible();
  await pair(page, row, `${REVIEW}/owner-1029/cf5-draft.html`, '.sec .card .msg', 'fork');
});

test('HIDEROWS: simple and risky session rows against the approved r6', async ({ app, core }) => {
  // The mockup draws the line under a worktree row; a shell session's line sits under the project head instead, so the
  // audit's row 02/14 shots compared a different construct and read partly as a fixture difference.
  const p = repo(core, 'lumen');
  for (const b of ['feature-x', 'build-fix', 'sizing-v2']) worktree(core, p, b);
  // worktree() opens each row's own session with the branch as its label.
  const session = (label: string) => (core.cli('snapshot', '--json').sessions as { id: string; label: string }[]).filter((s) => s.label === label).at(-1)!;
  const simple = session('build-fix');
  const risky = session('sizing-v2');
  openQuiet(core);
  await riskPatches(app, { 'build-fix': { waiting: 'permission', text: 'npm test 실행 허용?' }, 'sizing-v2': { waiting: 'permission', text: 'build/ 삭제 허용?', risky: true } });
  await openWindow(app);
  // The whole `.sess` (row and line), as the mockup selector crops it; the line alone drops the row the mockup names.
  const block = (id: string) => app.locator(`.sess:has(.q[data-line="${id}"])`);
  await pair(app, block(simple.id), `${KO}/hiderows-r6.html`, '.pane[data-rows*="simple"] .sess[data-n="build-fix"]', 'decision-simple');
  await pair(app, block(risky.id), `${KO}/hiderows-r6.html`, '.pane[data-rows*="risky"] .sess[data-n="sizing-v2"]', 'decision-risky');
});

test('CF3 and context-menu fidelity: branch label and visible worktree actions', async ({ app, core }) => {
  const p = repo(core, 'lumen');
  worktree(core, p, 'v2-undo');
  openQuiet(core);
  await openWindow(app);
  const row = app.locator('[data-menu="worktree"]', { hasText: 'v2-undo' }).first();
  await row.click({ button: 'right' });
  await pair(app, app.locator('.cmenu'), `${ROOT}/.scratch/v2-drafts/05-context-undo.html`, '#o5a .menu', 'context');
});

test('worktree discard: three changed files and two retained commits', async ({ app, core }) => {
  const p = repo(core, 'nunchiro');
  const inRepo = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args]);
  fs.writeFileSync(path.join(p, 'undo.rs'), 'old');
  fs.writeFileSync(path.join(p, 'undo-sketch.md'), 'sketch');
  inRepo(p, 'add', '.'); inRepo(p, 'commit', '-qm', 'initial files');
  inRepo(p, 'remote', 'add', 'origin', p);
  inRepo(p, 'fetch', '-q', 'origin', 'main');
  const w = create(core, p, 'v2-undo');
  inRepo(w.path, 'branch', '--set-upstream-to=origin/main', 'v2-undo');
  for (const message of ['Add undo stack', 'Wire undo to palette']) inRepo(w.path, 'commit', '-qm', message, '--allow-empty');
  fs.writeFileSync(path.join(w.path, 'undo.rs'), 'new');
  fs.writeFileSync(path.join(w.path, 'undo.test.ts'), '// test');
  fs.rmSync(path.join(w.path, 'undo-sketch.md'));
  inRepo(w.path, 'add', 'undo.test.ts');
  core.shell(p, 'main');
  openQuiet(core);
  await openWindow(app);
  const row = app.locator('.row.wt2').filter({ hasText: 'v2-undo' }).first();
  await row.focus();
  await app.keyboard.press('Backspace');
  const dialog = app.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await pair(app, dialog, `${KO}/v2-8a-compare-r3.html`, 'section[aria-labelledby="h-d1"] .dlg[aria-label^="v2-undo"]', 'discard');
});

  async function openHits(page: Page, core: Core & { chat: (label: string) => { id: string; file: string } }) {
    const seedSession = (label: string, texts: string[], close = false) => {
      const s = core.chat(label);
      append(s.file, ...texts.map((t) => rec.assistant(t)));
      if (close) core.cli('session', 'close', s.id);
    };
    // The window lists the newest session first, the draft lists core-serve first: created in the reverse order.
    seedSession('v1a-16', ['worktree remove should retire sessions first'], true);
    seedSession('relay-check', ['holder must not retire the PTY master before the core detaches']);
    seedSession('v1a-40', ['scrollback ring: retire the oldest chunk when over 1 MiB'], true);
    seedSession('core-serve', ['The group was not retired before reap, so a zombie could stay.', 'self.retire_group(pgid)?; then reap']);
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const panel = page.locator('.sbar .spanel');
    await panel.getByRole('radio', { name: 'Sessions' }).click();
    await panel.getByRole('searchbox').fill('retire');
    await panel.getByRole('searchbox').press('Enter');
    await expect(panel.locator('.sscope:not([hidden]) .sstat')).toHaveText(/^5 matches in 4 sessions/);
    await page.mouse.move(900, 600);
    return panel;
  }


chatTest('search: the approved five retire hits in four sessions', async ({ page, chatCore }) => {
  const panel = await openHits(page, chatCore);
  await pair(page, panel.locator('.sscope:not([hidden]) .hits'), `${ROOT}/.scratch/v2-drafts/06-search.html`, '#o6a [role="listbox"]', 'search');
});
