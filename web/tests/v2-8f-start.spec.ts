import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core, REPO } from './fixtures';
import { repo, show } from './visual/compare';
import { openQuiet } from './tree-seed';
import { startOf } from './start-op';

const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; cwd: string; project: string; kind: string; model: string | null; state: string }[];
const worktrees = (core: Core) => core.cli('worktree', 'list').worktrees as { path: string; branch: string }[];

async function open(app: Page, core: Core) {
  const project = repo(core, 'nunchiro');
  core.shell(project, 'main');
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  openQuiet(core);
  await show(app, 'light');
  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  return { project, dialog: app.getByRole('dialog', { name: 'New worktree', exact: true }) };
}

test('preview_stays_under_input', async ({ app, core }) => {
  const { dialog } = await open(app, core);
  const name = dialog.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' });
  const preview = dialog.getByRole('status');
  const advanced = dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' });
  await name.fill('fix login redirect');
  await expect(preview).toHaveText('Creates fix-login-redirect from current branch');
  const ordered = async (fields: typeof name[]) => {
    const boxes = await Promise.all(fields.map(field => field.boundingBox()));
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i - 1]!.y + boxes[i - 1]!.height, `field ${i} stays above field ${i + 1}`).toBeLessThanOrEqual(boxes[i]!.y);
    }
  };
  await ordered([name, preview, advanced]);
  await advanced.click();
  const base = dialog.getByRole('textbox', { name: 'Base branch', exact: true });
  await ordered([name, preview, advanced, base]);
  await dialog.getByRole('checkbox', { name: 'Start an agent here' }).check();
  const prompt = dialog.getByRole('textbox', { name: 'First prompt (optional)' });
  const confirm = dialog.getByRole('button', { name: 'Create and start', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await ordered([name, preview, advanced, base, prompt, confirm]);
  await ordered([prompt, cancel]);
  fs.unlinkSync(path.join(core.home, 'bin/claude'));
  await confirm.click();
  await expect(dialog.getByRole('alert')).toContainText('Could not start the agent');
  const retry = dialog.getByRole('button', { name: 'Retry start', exact: true });
  await expect(retry).toBeEnabled();
  await ordered([name, preview, advanced, base, prompt, dialog.getByRole('alert'), retry]);
  await ordered([dialog.getByRole('alert'), cancel]);
});

test('create_and_start_makes_worktree_then_session', async ({ app, core }) => {
  const { project, dialog } = await open(app, core);
  await dialog.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' }).fill('fix login redirect');
  await dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await dialog.getByRole('checkbox', { name: 'Start an agent here' }).check();
  await dialog.getByRole('button', { name: 'Model', exact: true }).click();
  await dialog.getByRole('option', { name: 'Haiku', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).dblclick();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => worktrees(core).length).toBe(1);
  const wt = worktrees(core)[0];
  expect(wt.branch).toBe('fix-login-redirect');
  await expect.poll(() => sessions(core).filter(s => s.kind === 'claude').length).toBe(1);
  const started = sessions(core).find(s => s.kind === 'claude')!;
  expect(started).toMatchObject({ project, cwd: wt.path, state: 'running', model: 'haiku' });
  expect(fs.existsSync(wt.path)).toBe(true);
  expect(core.cli('agent', 'get', started.id, '--json').send_log).toHaveLength(0);
  expect(core.cli('agent', 'get', started.id, '--json').send_queue).toHaveLength(0);
  await expect(app.locator('.grp[data-project]')).toHaveCount(1);
  await expect(app.locator('.grp[data-project="nunchiro"] .row.wt2:not([data-menu="treerow"])')).toContainText('fix-login-redirect');
});

async function chooseStart(dialog: ReturnType<Page['getByRole']>) {
  await dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Start an agent here' })).toBeVisible({ timeout: 2000 });
  await dialog.getByRole('checkbox', { name: 'Start an agent here' }).check();
}

test('start_failure_keeps_worktree_and_offers_retry', async ({ app, core }) => {
  const { dialog } = await open(app, core);
  await dialog.getByRole('textbox').fill('retry start');
  await chooseStart(dialog);
  fs.unlinkSync(path.join(core.home, 'bin/claude'));
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not start the agent');
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
  expect(worktrees(core)).toHaveLength(1);
  const wt = worktrees(core)[0];
  expect(fs.existsSync(wt.path)).toBe(true);
  expect(sessions(core).filter(s => s.kind === 'claude')).toMatchObject([{ state: 'failed', cwd: wt.path }]);
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/claude-picker'), path.join(core.home, 'bin/claude'));
  await dialog.getByRole('button', { name: 'Retry start', exact: true }).dblclick();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sessions(core).filter(s => s.cwd === wt.path).length).toBe(1);
  expect(worktrees(core)).toEqual([wt]);
});

// Q9 es-J13-1: a setup script that never ends leaves Cancel, Esc and a click outside working; no agent starts after.
test('setup_wait_can_be_cancelled', async ({ app, core }) => {
  const sent: string[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request?.op) sent.push(msg.request.op);
      if (msg?.request?.op === 'setup_status') return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'setup_status', status: { agent: 'wait' } } } }));
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  const { dialog } = await open(app, core);
  await dialog.getByRole('textbox').fill('slow setup');
  await chooseStart(dialog);
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect.poll(() => sent.filter((op) => op === 'setup_status').length).toBeGreaterThan(0);
  await expect(dialog.getByRole('button', { name: 'Create and start', exact: true })).toHaveCount(0); // it reads Starting
  const cancels = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancels.first()).toBeEnabled();
  await cancels.last().click();
  await expect(dialog).toHaveCount(0);
  const polls = sent.filter((op) => op === 'setup_status').length;
  await app.waitForTimeout(2500);
  expect(sent.filter((op) => op === 'setup_status').length - polls).toBeLessThanOrEqual(1);
  expect(sent).not.toContain('start');
  expect(worktrees(core)).toHaveLength(1);
});

test('first_prompt_sent_once', async ({ app, core }) => {
  const { dialog } = await open(app, core);
  const fake = path.join(core.home, 'bin/claude');
  // Hold the real delivery boundary before the fake agent draws its composer.
  fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace('tty.setraw(0)', "tty.setraw(0)\nwhile not os.path.exists(os.path.join(home, 'ready-first')):\n    time.sleep(0.02)"));
  await dialog.getByRole('textbox').fill('first prompt');
  await chooseStart(dialog);
  const prompt = 'Check this worktree once. 한글 메모 ' + 'a'.repeat(220);
  await dialog.getByRole('textbox', { name: 'First prompt (optional)' }).fill(prompt);
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).dblclick();
  await expect(dialog).toHaveCount(0);
  const id = sessions(core).find(s => s.kind === 'claude')!.id;
  type Send = { content: string; status: string; submit: boolean };
  const row = () => core.cli('agent', 'get', id, '--json') as { send_queue: Send[]; send_log: Send[] };
  await expect.poll(() => row().send_queue).toMatchObject([{ content: prompt, status: 'queued', submit: true }]);
  // The fake agent creates its stdin log when it starts; a loaded host can poll before that (nothing read yet).
  const log = path.join(core.home, `stdin-${id}.log`);
  const reads = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(l => l.startsWith('READ '));
  expect(reads()).toHaveLength(0);
  fs.writeFileSync(path.join(core.home, 'ready-first'), '');
  await expect.poll(() => row().send_log).toMatchObject([{ content: prompt, status: 'delivered', submit: true }]);
  await expect.poll(() => reads().map(l => Buffer.from(l.slice(5), 'hex').toString('utf8')).join('')).toBe(prompt + '\r');
  expect(row().send_queue).toHaveLength(0);
  expect(row().send_log).toHaveLength(1);
  expect(sessions(core).filter(s => s.kind === 'claude')).toHaveLength(1);
});

test('first_prompt_never_resent_after_error', async ({ app, core }) => {
  const sent: { op: string; id?: string }[] = [];
  let promptRequest: number | undefined;
  let agent = '';
  let injected = false;
  const prompt = 'Send this worktree prompt once.';
  const reads = () => fs.readFileSync(path.join(core.home, `stdin-${agent}.log`), 'utf8')
    .split('\n').filter(line => line.startsWith('READ ')).map(line => Buffer.from(line.slice(5), 'hex').toString('utf8')).join('');
  await app.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(async m => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.request) sent.push(msg.request);
      if (msg?.request?.op === 'agent_prompt') {
        promptRequest = msg.id;
        agent = msg.request.id;
        await expect.poll(() => fs.existsSync(path.join(core.home, 'composer-ready'))).toBe(true);
        await expect(app.getByRole('combobox', { name: "Message New Claude session", exact: true })).toBeVisible();
      }
      server.send(m);
    });
    server.onMessage(async m => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (!injected && msg?.id === promptRequest && msg?.response?.Ok) {
        expect(msg.response.Ok.send.status).toBe('delivered');
        await expect.poll(reads).toBe(prompt + '\r');
        // Post-delivery EIO at the API boundary, as if finish_send's final store write failed.
        injected = true;
        ws.send(JSON.stringify({ ...msg, response: { Err: 'Input/output error (os error 5)' } }));
      } else ws.send(m);
    });
  });
  const { dialog } = await open(app, core);
  const fake = path.join(core.home, 'bin/claude');
  fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8').replace('draw()\nwhile True:',
    "sys.stdout.write('\\x1b[?2004l')\nsys.stdout.flush()\ndraw()\nopen(os.path.join(home, 'composer-ready'), 'w').close()\nwhile True:"));
  await dialog.getByRole('textbox').fill('prompt error');
  await chooseStart(dialog);
  await dialog.getByRole('textbox', { name: 'First prompt (optional)' }).fill(prompt);
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).dblclick();
  await expect(app.getByText(/may have been sent|prompt was refused/)).toBeVisible();
  // Try the old unsafe action if it is offered after the error; subsequent replies are healthy.
  const retry = app.getByRole('button', { name: 'Retry prompt', exact: true });
  if (await retry.count()) await retry.click();
  expect(injected).toBe(true);
  expect(sent.filter(r => r.op === 'agent_prompt')).toHaveLength(1);
  await expect(dialog).toHaveCount(0);
  await expect(app.getByText('The first prompt may have been sent; check the session before sending again', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(app.getByRole('combobox', { name: "Message New Claude session", exact: true })).toBeVisible();
  await expect(app.getByRole('combobox', { name: "Message New Claude session", exact: true })).toBeEnabled();
  expect(reads()).toBe(prompt + '\r');
  expect(sent.filter((r) => startOf(r))).toHaveLength(1);
  expect(sessions(core).filter(s => s.kind === 'claude')).toHaveLength(1);
  expect(worktrees(core)).toHaveLength(1);
  fs.mkdirSync(path.join(REPO, '.scratch/v2-8f'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    await app.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await app.screenshot({ path: path.join(REPO, `.scratch/v2-8f/prompt-error-${theme}.png`) });
  }
});

test('create_and_start_uses_existing_authority', async ({ app, core }) => {
  const sent: { op: string; session?: object }[] = [];
  app.on('websocket', ws => ws.on('framesent', frame => {
    if (typeof frame.payload === 'string') {
      const r = JSON.parse(frame.payload).request;
      if (r) sent.push(r);
    }
  }));
  const { project, dialog } = await open(app, core);
  const fake = path.join(core.home, 'bin/claude');
  fs.writeFileSync(fake, fs.readFileSync(fake, 'utf8')
    .replace("args = sys.argv[1:]", "if sys.argv[1:3] == ['auth', 'status']:\n    print('{}')\n    raise SystemExit\nargs = sys.argv[1:]")
    .replace("if '--fixture-token' in args:", 'if True:'));
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];
  for (const id of ids) fs.mkdirSync(path.join(core.home, 'accounts/claude', id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), 'version = 1\n' + ids.map((id, i) => `\n[[accounts]]\nagent = "claude"\nid = "${id}"\nlabel = "${i ? 'Other' : 'Work'}"\n`).join(''));
  await dialog.getByRole('textbox').fill('authority');
  await chooseStart(dialog);
  await dialog.getByRole('radio', { name: 'Work', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const wt = worktrees(core)[0];
  const parent = sessions(core).find(s => s.kind === 'claude')!;
  expect(sent.map(startOf).filter((r) => r)).toEqual([{ op: 'start', folder: wt.path, session: { kind: 'claude', project, model: null, effort: null, resume: null, account: 'Work' } }]);
  await expect.poll(() => fs.existsSync(path.join(core.home, `token-${parent.id}`))).toBe(true);
  // Same existing API with a real session token: cross-account refused, omitted account inherits Work.
  const request = (account?: string) => JSON.parse(execFileSync(process.execPath, ['-e', `
    const net = require('net'), fs = require('fs'), path = require('path');
    const [home, id, request] = process.argv.slice(1);
    const s = net.connect(path.join(home, 'core.sock')); let b = '';
    s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(home, 'token-' + id), 'utf8'), request: JSON.parse(request) }) + '\\n'));
    s.on('data', d => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });
    s.on('error', () => process.exit(1));
  `, core.home, parent.id, JSON.stringify({ op: 'start', folder: wt.path, session: { kind: 'claude', project, model: null, resume: null, ...(account ? { account } : {}) } })], { encoding: 'utf8', timeout: 10000 }));
  expect(request('Other')).toEqual({ Err: 'a session can start sessions only on its own account' });
  expect(sessions(core).filter(s => s.kind === 'claude')).toHaveLength(1);
  expect(request().Ok.session).toMatchObject({ account: 'Work', cwd: wt.path, state: 'running' });
  expect(sessions(core).filter(s => s.kind === 'claude')).toHaveLength(2);
});

test('default_off_one_click_unchanged', async ({ app, core }) => {
  const { dialog } = await open(app, core);
  const original = await dialog.screenshot();
  await dialog.getByRole('textbox').fill('default off');
  await dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Start an agent here' })).toBeVisible({ timeout: 2000 });
  await expect(dialog.getByRole('checkbox', { name: 'Start an agent here' })).not.toBeChecked();
  await app.keyboard.press('Escape');
  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  expect(await dialog.screenshot()).toEqual(original);
  await dialog.getByRole('textbox').fill('default off');
  await dialog.getByRole('textbox').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => worktrees(core).map(w => w.branch)).toEqual(['default-off']);
  expect(sessions(core)).toHaveLength(1);
  expect(sessions(core)[0].kind).toBe('shell');
});

for (const op of ['start', 'agent_prompt']) {
  test(`lost_${op}_reply_does_not_repeat_start_or_prompt`, async ({ app, core }) => {
    const pending = new Set<number>();
    await app.routeWebSocket(/\/ws$/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(m => {
        if (typeof m === 'string') {
          const msg = JSON.parse(m);
          if (msg.request?.op === op) pending.add(msg.id);
        }
        server.send(m);
      });
      server.onMessage(m => {
        if (typeof m === 'string' && pending.has(JSON.parse(m).id)) return ws.close({ code: 1011, reason: 'lost reply' });
        ws.send(m);
      });
    });
    const { dialog } = await open(app, core);
    await dialog.getByRole('textbox').fill('lost reply');
    await chooseStart(dialog);
    await dialog.getByRole('textbox', { name: 'First prompt (optional)' }).fill('only once');
    await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
    if (op === 'agent_prompt') {
      await expect(dialog).toHaveCount(0);
      await expect(app.getByText('The first prompt may have been sent; check the session before sending again', { exact: true })).toBeVisible();
      await expect(app.getByRole('button', { name: 'Retry prompt', exact: true })).toHaveCount(0);
    } else {
      await expect(dialog.getByRole('alert')).toContainText('The reply was lost');
      await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeDisabled();
    }
    expect(worktrees(core)).toHaveLength(1);
    expect(sessions(core).filter(s => s.kind === 'claude')).toHaveLength(1);
    expect(pending.size).toBe(1);
    const id = sessions(core).find(s => s.kind === 'claude')!.id;
    if (op === 'agent_prompt') {
      await expect.poll(() => core.cli('agent', 'get', id, '--json').send_log).toMatchObject([{ content: 'only once', status: 'delivered' }]);
      expect(core.cli('agent', 'get', id, '--json').send_log).toHaveLength(1);
    } else {
      expect(core.cli('agent', 'get', id, '--json').send_log).toHaveLength(0);
    }
  });
}

/** Owner/session socket boundary, with only synthetic test tokens read inside the child process. */
function socket(core: Core, request: object, caller?: string) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `
    const net = require('net'), fs = require('fs'), path = require('path');
    const [home, request, caller] = process.argv.slice(1);
    const s = net.connect(path.join(home, 'core.sock')); let b = '';
    s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(home, caller ? 'token-' + caller : 'core.token'), 'utf8').trim(), request: JSON.parse(request) }) + '\\n'));
    s.on('data', d => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });
    s.on('error', () => process.exit(1));
  `, core.home, JSON.stringify(request), caller ?? ''], { encoding: 'utf8', timeout: 10000 }));
}

test('folder_start_rejects_unmanaged_mismatched_missing_and_alias_paths', async ({ core }) => {
  const project = repo(core, 'parent');
  const other = repo(core, 'other');
  const created = core.cli('worktree', 'create', '--project', project, '--branch', 'owned', '--no-focus').worktrees[0];
  const otherWt = core.cli('worktree', 'create', '--project', other, '--branch', 'elsewhere', '--no-focus').worktrees[0];
  const alias = path.join(core.home, 'alias');
  fs.symlinkSync(created.path, alias);
  const session = { kind: 'shell', project, model: null, effort: null, resume: null, args: ['/bin/cat'] };
  for (const folder of [project, core.project('unmanaged'), otherWt.path, alias, created.path + '/..', created.path + '/missing', 'relative']) {
    expect(socket(core, { op: 'start', folder, session }).Err).toBe('start folder is not a managed worktree of this project');
    expect(sessions(core)).toHaveLength(0);
  }
  for (const extra of [{ worktree: true }, { resume: 'aaaaaaaa-0000-4000-8000-000000000001' }]) {
    expect(socket(core, { op: 'start', folder: created.path, session: { ...session, ...extra } }).Err).toBe('folder cannot be combined with worktree or resume');
    expect(sessions(core)).toHaveLength(0);
  }
  expect(socket(core, { op: 'start', folder: created.path, session }).Ok.session).toMatchObject({ project, cwd: created.path, state: 'running' });
  // Omitting the argument retains the legacy start path.
  expect(socket(core, { op: 'start', session }).Ok.session).toMatchObject({ project, cwd: project, state: 'running' });
});

test('folder_start_remote_grant_is_exact_path_and_creator_bound', async ({ core }) => {
  const project = repo(core, 'parent');
  const parent = core.shell(project, 'caller', '/bin/sh', '-c', 'printf %s "$NUNCHIRO_TOKEN" > "$NUNCHIRO_HOME/token-$NUNCHIRO_SESSION"; exec /bin/cat');
  await expect.poll(() => fs.existsSync(path.join(core.home, `token-${parent.id}`))).toBe(true);
  const ownerWt = core.cli('worktree', 'create', '--project', project, '--branch', 'owner-made', '--no-focus').worktrees[0];
  const made = socket(core, { op: 'worktree', operation: 'create', project, from: null, branch: 'caller-owned', path: null, label: '', base: 'HEAD' }, parent.id);
  expect(made.Err).toBeUndefined();
  const created = made.Ok.worktrees.find((w: { branch: string }) => w.branch === 'caller-owned');
  const session = { kind: 'shell', project, model: null, effort: null, resume: null, args: ['/bin/cat'] };
  // Local callers retain needs 47: owner-created worktrees are still usable by a session token.
  expect(socket(core, { op: 'start', folder: ownerWt.path, session }, parent.id).Ok.session).toMatchObject({ project, cwd: ownerWt.path, state: 'running' });
  const forwarded = (folder: string) => socket(core, { op: 'forwarded', caller: { id: parent.id, project, permission_answers: false }, request: { op: 'start', folder, session } });
  for (const folder of [ownerWt.path, created.path + '/..', created.path + '-sibling']) {
    expect(forwarded(folder)).toEqual({ Err: 'outside session grants' });
    expect(sessions(core)).toHaveLength(2);
  }
  expect(forwarded(created.path).Ok.session).toMatchObject({ project, cwd: created.path, state: 'running' });
});

test('folder_start_refuses_broken_store_without_rewriting_it', async ({ core }) => {
  const project = repo(core, 'parent');
  const wt = core.cli('worktree', 'create', '--project', project, '--branch', 'kept', '--no-focus').worktrees[0];
  const file = path.join(core.home, 'worktrees.json');
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const session = { kind: 'shell', project, model: null, effort: null, resume: null, args: ['/bin/cat'] };
  for (const bad of [[], { ...good, version: 'one' }, { ...good, worktrees: [good.worktrees[0], good.worktrees[0]] }]) {
    const bytes = JSON.stringify(bad);
    fs.writeFileSync(file, bytes);
    expect(socket(core, { op: 'start', folder: wt.path, session }).Err).toMatch(/invalid worktree store/);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(sessions(core)).toHaveLength(0);
  }
});

test('older_core_ignoring_folder_never_gets_first_prompt', async ({ app, core }) => {
  let prompts = 0;
  await app.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(m => {
      if (typeof m === 'string') {
        const msg = JSON.parse(m);
        // Older cores ignore this optional argument and start in the parent project.
        const start = startOf(msg.request);
        if (start) {
          delete start.folder;
          return server.send(JSON.stringify(msg));
        }
        if (msg.request?.op === 'agent_prompt') prompts++;
      }
      server.send(m);
    });
    server.onMessage(m => ws.send(m));
  });
  const { project, dialog } = await open(app, core);
  await dialog.getByRole('textbox').fill('wrong folder');
  await chooseStart(dialog);
  await dialog.getByRole('textbox', { name: 'First prompt (optional)' }).fill('must stay in the worktree');
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('The agent started in a different folder');
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeDisabled();
  const agent = sessions(core).find(s => s.kind === 'claude')!;
  expect(agent.cwd).toBe(project);
  expect(prompts).toBe(0);
  expect(core.cli('agent', 'get', agent.id, '--json').send_log).toHaveLength(0);
  expect(core.cli('agent', 'get', agent.id, '--json').send_queue).toHaveLength(0);
  expect(worktrees(core)).toHaveLength(1);
});

test('start_agent_follows_new_session_rule: the default agent is the start value, and a pick wins over it', async ({ app, core }) => {
  const { dialog } = await open(app, core);
  const startAgent = async () => {
    await dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' }).click();
    await dialog.getByRole('checkbox', { name: 'Start an agent here' }).check();
  };
  await startAgent();
  await expect(dialog.getByRole('radio', { name: 'Claude' })).toBeChecked(); // no default and no agent session yet
  await app.evaluate(() => {
    const key = 'nunchiro.settings.v1';
    const s = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...s, features: { ...s.features, 'onboarding.default_agent': 'codex' } }));
  });
  await app.reload();
  await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
  await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  await startAgent();
  await expect(dialog.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await dialog.getByRole('radio', { name: 'Claude' }).check();
  await expect(dialog.getByRole('radio', { name: 'Claude' })).toBeChecked();
});

test('start_agent_choice_remembered: on and Codex after a create and a reload; Advanced opens with it; off is remembered too', async ({ app, core }) => {
  const { project, dialog } = await open(app, core);
  fs.copyFileSync(path.join(REPO, 'crates/nunchiro/tests/fixtures/codex-picker'), path.join(core.home, 'bin/codex'));
  execFileSync('git', ['branch', 'feature-x'], { cwd: project });
  const box = dialog.getByRole('checkbox', { name: 'Start an agent here' });
  const name = dialog.getByRole('textbox', { name: 'New worktree name, task, or GitHub PR or issue URL' });
  const reopen = async () => {
    await app.locator('.grp[data-project="nunchiro"] .row.head').hover();
    await app.getByRole('button', { name: 'New worktree in nunchiro', exact: true }).click();
  };
  await dialog.getByRole('textbox').fill('remember on');
  await chooseStart(dialog);
  await dialog.getByRole('radio', { name: 'Codex' }).check();
  await dialog.getByRole('button', { name: 'Create and start', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => sessions(core).filter(s => s.kind === 'codex').length).toBe(1);
  // Reopened with no click on Advanced: the box is in view, on, with the same agent, and typing still goes to the name.
  await reopen();
  await expect(box).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Codex' })).toBeChecked();
  await expect(name).toBeFocused();
  await app.keyboard.type('second task');
  await app.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => worktrees(core).map(w => w.branch).sort()).toEqual(['remember-on', 'second-task']);
  await expect.poll(() => sessions(core).filter(s => s.kind === 'codex').length).toBe(2);
  // Existing branches are still offered with Advanced open, while Base and Branch name are empty.
  await reopen();
  await expect(name).toBeFocused();
  await app.keyboard.type('feature-x');
  const existing = dialog.getByRole('option', { name: 'Use existing branch feature-x' });
  await expect(existing).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('mine');
  await expect(existing).toHaveCount(0);
  await app.keyboard.press('Escape');
  await app.reload();
  await reopen();
  await expect(box).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Codex' })).toBeChecked();
  // Off is a choice too: the next dialog starts off and a plain Enter starts only the worktree.
  await name.fill('remember off');
  await box.uncheck();
  await name.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => worktrees(core).map(w => w.branch).sort()).toEqual(['remember-off', 'remember-on', 'second-task']);
  await reopen();
  await expect(dialog.getByRole('button', { name: '⌥↵ Advanced: base and branch' })).toHaveAttribute('aria-expanded', 'false');
  expect(sessions(core).filter(s => s.kind === 'codex')).toHaveLength(2);
});
