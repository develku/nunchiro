// Ticket 1123 (first use; owner-approved mockup docs/design/first-use-1123/mockup.html, owner 11-25 "추천대로"): T1 Quick
// setup's Folder row and first prompt, and T10's one-field MCP add with "Restart <session> with it". One test per panel.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, type Core } from './fixtures';
import { ownerOk } from './acp-fakes';

// The Folder list shows the home folder as ~ (settings/shell/Row.tsx `tilde`); a checkout under /Users/<name> shows it so.
const tilde = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

const SHOTS = path.resolve(import.meta.dirname, '../../.scratch/first-use-1123');
// The copy's own folders are masked: the shots are committed, and a test home's path names this machine.
const shot = (app: Page, name: string) => app.screenshot({ path: path.join(SHOTS, name + '.png'), mask: [app.locator('.ext-dir')] });
type Snap = { id: string; project: string; state: string; kind: string; agent_session_id?: string | null };
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const quick = (app: Page) => app.locator('.ob-quick:not(.ob-preflight)');

/** Claude's own history: one conversation per folder, the file's time as its last use. */
function history(core: Core, folders: [string, number][]) {
  for (const [folder, at] of folders) {
    const dir = path.join(core.home, 'claude-home/projects', folder.replaceAll('/', '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${path.basename(folder)}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: folder, message: { role: 'user', content: 'hello' } }) + '\n');
    fs.utimesSync(file, at / 1000, at / 1000);
  }
}
/** The requests the window sends, the socket passed through unchanged. */
async function record(app: Page) {
  const sent: { op: string; [k: string]: unknown }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m).request : null;
      if (r) sent.push(r);
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return sent;
}
const folderPanel = (app: Page, answer: string) =>
  app.addInitScript((a) => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
  }, answer);

test.describe('first run', () => {
  test.use({ firstRun: true, colorScheme: 'light' });

  test('t1_folder_and_prompt: the Folder row lists Claude history folders newest first; type + Enter starts Claude there with that prompt', async ({ app, core }) => {
    const [older, newer] = [core.project('api-server'), core.project('my-app')];
    history(core, [
      [older, Date.now() - 5 * 86_400_000],
      [newer, Date.now() - 2 * 86_400_000],
      [path.join(core.home, 'moved-away'), Date.now() - 86_400_000], // the newest, but no longer on disk: not listed
    ]);
    const sent = await record(app);
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await expect(folder).toHaveValue(newer, { timeout: 15_000 });
    await expect(folder.locator('option')).toHaveText([`my-app (${tilde(newer)})`, `api-server (${tilde(older)})`, 'Choose folder…']);
    await expect(quick(app).locator('.ob-sel')).toContainText('last used with Claude, 2 days ago');
    const prompt = quick(app).getByRole('textbox', { name: 'First prompt' });
    await expect(prompt).toBeFocused();
    await prompt.fill('Add a dark mode switch to the settings page');
    await prompt.press('Enter');
    await expect.poll(() => sessions(core).filter((s) => s.state === 'running').map((s) => [s.project, s.kind]), { timeout: 15_000 }).toContainEqual([newer, 'claude']);
    await expect(app.locator('.settings')).toHaveCount(0);
    const id = sessions(core).find((s) => s.project === newer)!.id;
    // The prompt is the session's first message: it waits while the fake agent's start question is open, then goes.
    await expect(app.getByRole('status').filter({ hasText: 'Add a dark mode switch to the settings page' })).toBeVisible();
    const ask = () => (core.cli('snapshot', '--json').sessions as (Snap & { pending: { id: string }[] })[]).find((s) => s.id === id)?.pending[0]?.id;
    await expect.poll(ask, { timeout: 15_000 }).toBeTruthy();
    expect(sent.some((r) => r.op === 'send_text' && r.id === id)).toBe(false); // nothing typed into the question
    ownerOk(core, { op: 'answer', item: ask(), answer: { type: 'allow_once' }, confirmed: true }); // the fake's question reads as risky
    await expect.poll(() => sent.some((r) => r.op === 'send_text' && r.id === id && String(r.text).includes('Add a dark mode switch')), { timeout: 15_000 }).toBe(true);
    // The fake agent writes no transcript and sends no hooks: they are written as Claude would, so the shot shows the sent turn.
    const s = sessions(core).find((x) => x.id === id) as Snap & { cwd: string; agent_session_id: string };
    const file = core.transcriptPath(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'Add a dark mode switch to the settings page' } }) + '\n');
    core.hook(id, 'UserPromptSubmit', { prompt: 'Add a dark mode switch to the settings page' });
    await expect(app.locator('.chat, [data-chat]').getByText('Add a dark mode switch to the settings page').first()).toBeVisible({ timeout: 15_000 });
    await app.waitForTimeout(1000);
    await shot(app, 't1-after-2-session');
    // Today's quick() settings were applied too.
    const features = (await app.evaluate(() => JSON.parse(localStorage.getItem('nunchiro.settings.v1') ?? '{}'))).features ?? {};
    expect(features['onboarding.default_agent']).toBe('claude');
    expect(features['onboarding.marks']).toEqual(expect.arrayContaining(['appearance', 'keys', 'skills']));
  });

  test('t1_folder_row_reads_home_folders: a folder under a home shows as ~/…, and the line says when its agent last used it', async ({ app, core }) => {
    // Display only (never started): real folders, shown under a home path so the shot reads as the mockup's panel. The
    // window's copy of the listing gets the home prefix; the core still checks the real folders exist. The home is split
    // as test_publish_scan.py splits its own, so the publish scan does not read a made-up home as a person's.
    const home = '/' + 'Users/you/code';
    const root = path.dirname(core.project('my-app'));
    history(core, [[core.project('api-server'), Date.now() - 5 * 86_400_000], [core.project('my-app'), Date.now() - 2 * 86_400_000]]);
    await app.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(typeof m === 'string' && m.includes('"folders"') ? m.replaceAll(root, home) : m));
    });
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await expect(folder).toHaveValue(`${home}/my-app`, { timeout: 15_000 });
    await expect(folder.locator('option')).toHaveText(['my-app (~/code/my-app)', 'api-server (~/code/api-server)', 'Choose folder…']);
    await quick(app).getByRole('textbox', { name: 'First prompt' }).fill('Add a dark mode switch to the settings page');
    await shot(app, 't1-after-1-quick');
  });

  // Ticket 1130 C7: with no history the row starts on Assistants; its line's "Choose folder…" is the one click (firstuse-1130.spec.ts).
  test('t1_no_history: Choose folder…; pick, Open, type, Enter starts Claude in the picked folder', async ({ app, core }) => {
    const picked = core.project('picked');
    await folderPanel(app, picked);
    await app.goto('/');
    await quick(app).getByRole('button', { name: 'Choose folder…' }).click({ timeout: 15_000 });
    await expect(quick(app).getByRole('combobox', { name: 'Folder' })).toHaveValue(picked);
    const prompt = quick(app).getByRole('textbox', { name: 'First prompt' });
    await prompt.fill('fix the build');
    await prompt.press('Enter');
    await expect.poll(() => sessions(core).filter((s) => s.state === 'running').map((s) => [s.project, s.kind]), { timeout: 15_000 }).toContainEqual([picked, 'claude']);
  });
});

test.describe('existing', () => {
  test.use({ colorScheme: 'light' });

  test('t10_paste_and_restart: a pasted claude mcp add line fills the name, Enter adds it, and Restart resumes the open session', async ({ app, core }) => {
    const project = core.project('api-server');
    const live = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'api-server').session as Snap;
    core.hook(live.id, 'UserPromptSubmit');
    core.hook(live.id, 'Stop'); // one finished turn, so the conversation resumes
    // The fake agent's question makes the session wait for you; Restart turns on only once it is idle.
    const ask = () => (core.cli('snapshot', '--json').sessions as (Snap & { pending: { id: string }[] })[]).find((s) => s.id === live.id)?.pending[0]?.id;
    await expect.poll(ask, { timeout: 15_000 }).toBeTruthy();
    ownerOk(core, { op: 'answer', item: ask(), answer: { type: 'allow_once' }, confirmed: true });
    await expect.poll(ask, { timeout: 15_000 }).toBeFalsy();
    await openWindow(app, {}, core);
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
    const own = app.locator('[data-mcp="own"]');
    const command = own.getByRole('textbox', { name: 'Command' });
    await expect(command).toBeFocused();
    await command.fill('npx -y @modelcontextprotocol/server-github');
    await expect(own.getByRole('textbox', { name: 'Server name' })).toHaveValue('github');
    await command.fill('claude mcp add x -- /bin/echo hi');
    await expect(own.getByRole('textbox', { name: 'Server name' })).toHaveValue('x');
    await own.scrollIntoViewIfNeeded();
    await shot(app, 't10-after-1-paste');
    await command.press('Enter');
    await expect(own.getByRole('status')).toHaveText('Added x. Sessions started from now on get it.');
    expect(ownerOk(core, { op: 'extensions_list' }).own).toEqual([expect.objectContaining({ name: 'x', command: ['/bin/echo', 'hi'] })]);
    await expect(own.getByRole('button', { name: 'New session' })).toBeVisible();
    // Mockup T10: the line sits under the new server's row, and the empty field comes last.
    const order = await own.evaluate((el) => [...el.children].map((c) => (c.matches('.ext-added') ? 'added' : c.matches('form') ? 'field' : c.textContent?.includes('/bin/echo hi') ? 'server' : 'other')));
    expect(order.filter((x) => x !== 'other')).toEqual(['server', 'added', 'field']);
    await expect(own.getByText('Keeps the conversation')).toBeVisible(); // a finished turn: Restart resumes it
    await shot(app, 't10-after-2-added');
    await own.getByRole('button', { name: /^Restart .* with it$/ }).click();
    await expect.poll(() => sessions(core).filter((s) => s.state === 'running' && s.kind === 'claude').map((s) => s.agent_session_id), { timeout: 15_000 }).toEqual([live.agent_session_id]);
    await expect(app.locator('.settings')).toHaveCount(0);
  });

  test('t10_env_values_and_agent_lines: -e values are named as not added and never stored; a codex line is refused', async ({ app, core }) => {
    core.shell(core.project('api-server'), 'term');
    await openWindow(app, {}, core);
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
    const own = app.locator('[data-mcp="own"]');
    const command = own.getByRole('textbox', { name: 'Command' });
    await command.fill('codex mcp add docs -- npx docs-mcp');
    await expect(own.locator('[data-field="mcp-problem"]')).toHaveText('This line runs claude or codex itself. Paste a "claude mcp add NAME -- COMMAND" line or the server\'s own command.');
    await expect(own.getByRole('button', { name: 'Add for Nunchiro sessions' })).toBeDisabled();
    await command.fill('claude mcp add --transport http notion https://mcp.notion.com/mcp');
    await expect(own.locator('[data-field="mcp-problem"]')).toContainText('remote (http or sse)');
    await command.fill('claude mcp add my-server -e API_KEY=s3cret-value -- /bin/echo hi');
    await expect(own.locator('[data-field="mcp-env"]')).toHaveText('Not added: the values of API_KEY. Servers added here get no environment values.');
    await expect(own.getByRole('button', { name: 'Add for Nunchiro sessions' })).toBeEnabled(); // off while the first read is busy
    await command.press('Enter');
    await expect(own.getByRole('status').filter({ hasText: 'Added my-server' })).toBeVisible({ timeout: 15_000 });
    expect(ownerOk(core, { op: 'extensions_list' }).own).toEqual([expect.objectContaining({ name: 'my-server', command: ['/bin/echo', 'hi'] })]);
    const stored = fs.readdirSync(path.join(core.home, 'extensions')).map((f) => fs.statSync(path.join(core.home, 'extensions', f)).isFile() ? fs.readFileSync(path.join(core.home, 'extensions', f), 'utf8') : '').join('');
    expect(stored).not.toContain('s3cret-value');
  });

  test('t10_restart_waits_for_the_turn: while the agent works Restart is off and says why; with no finished turn there is no "keeps" line', async ({ app, core }) => {
    const live = core.cli('session', 'start', '--kind', 'claude', '--project', core.project('api-server'), '--label', 'api-server').session as Snap;
    core.hook(live.id, 'UserPromptSubmit'); // a turn in progress, none finished
    await openWindow(app, {}, core);
    await app.keyboard.press('Meta+Comma');
    await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Skills & hooks' }).click();
    const own = app.locator('[data-mcp="own"]');
    await own.getByRole('textbox', { name: 'Command' }).fill('/bin/echo hi');
    // Enter submits only once Add is pressable (it is off while the page's first read is busy).
    await expect(own.getByRole('button', { name: 'Add for Nunchiro sessions' })).toBeEnabled();
    await own.getByRole('textbox', { name: 'Command' }).press('Enter');
    const restart = own.getByRole('button', { name: /^Restart .* with it$/ });
    await expect(restart).toBeDisabled();
    await expect(own).toContainText('api-server is busy (working or waiting for you). Restart once it is idle.');
    await expect(own.getByText('Keeps the conversation')).toHaveCount(0);
    expect(sessions(core).find((s) => s.id === live.id)?.state).toBe('running');
  });
});
