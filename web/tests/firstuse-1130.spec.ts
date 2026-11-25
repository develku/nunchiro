// Ticket 1130 B-L5 C7 (owner 11-25 Q3, mockup docs/design/first-use-b-1130/mockup.html, its two C7 frames): on a Mac with
// no Claude or Codex history, Quick setup's Folder row starts on Assistants with its line, so T1 is 2 steps: type, Enter.
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Core } from './fixtures';
import { ownerOk } from './acp-fakes';

const SHOTS = path.resolve(import.meta.dirname, '../../.scratch/firstuse-1130');
const shot = (app: Page, name: string) => app.screenshot({ path: path.join(SHOTS, name + '.png') });
type Snap = { id: string; project: string; state: string; kind: string; cwd: string; agent_session_id: string; pending: { id: string }[] };
const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];
const quick = (app: Page) => app.locator('.ob-quick:not(.ob-preflight)');
const PROMPT = 'Plan a small tool that renames my photos by date';

test.describe('first run, no agent history', () => {
  test.use({ firstRun: true, colorScheme: 'light' });

  test('t1_no_history_2_steps: the Folder row starts on Assistants with its line; 1 type, 2 Enter starts Claude in Assistants with the prompt', async ({ app, core }) => {
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
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await expect.poll(() => fs.existsSync(path.join(core.home, 'team/home')), { timeout: 15_000 }).toBe(true);
    const home = fs.realpathSync(path.join(core.home, 'team/home'));
    await expect(folder).toHaveValue(home, { timeout: 15_000 });
    await expect(folder.locator('option')).toHaveText([`Assistants (${home})`, 'Choose folder…']);
    await expect(quick(app).locator('.ob-sel b')).toHaveText('Assistants');
    await expect(quick(app).locator('[data-field="home-line"]')).toHaveText('No project yet: this runs in Assistants. Choose folder… to work on code.');
    await expect(quick(app).locator('[data-field="home-line"]').getByRole('button', { name: 'Choose folder…' })).toBeVisible();
    // Step 1: the prompt field has focus when the page opens; type.
    const prompt = quick(app).getByRole('textbox', { name: 'First prompt' });
    await expect(prompt).toBeFocused();
    await prompt.fill(PROMPT);
    // Display only, for the shot: a test home's long path names this machine; it reads as a real Mac's does.
    await quick(app).locator('.ob-sel > span > small').evaluate((el) => (el.textContent = '~/.nunchiro/team/home'));
    await shot(app, 'c7-frame1-quick-setup');
    // Step 2: Enter.
    await prompt.press('Enter');
    await expect.poll(() => sessions(core).filter((s) => s.state === 'running').map((s) => [s.project, s.kind]), { timeout: 15_000 }).toContainEqual([home, 'claude']);
    await expect(app.locator('.settings')).toHaveCount(0);
    expect(sent.some((r) => r.op === 'tree_edit')).toBe(false); // Assistants is not added as a project
    const id = sessions(core).find((s) => s.project === home)!.id;
    // The prompt is the first message: it waits while the fake agent's start question is open, then goes.
    const ask = () => sessions(core).find((s) => s.id === id)?.pending[0]?.id;
    await expect.poll(ask, { timeout: 15_000 }).toBeTruthy();
    ownerOk(core, { op: 'answer', item: ask(), answer: { type: 'allow_once' }, confirmed: true });
    await expect.poll(() => sent.some((r) => r.op === 'send_text' && r.id === id && String(r.text).includes(PROMPT)), { timeout: 15_000 }).toBe(true);
    // The session sits in the tree's Assistants group, under the 11-21 "Set up" row, not as a project of its own.
    const group = app.locator('.tree .home-grp');
    await expect(group.locator('[data-home-setup]')).toBeVisible();
    await expect(group.locator('.home-kid')).toHaveCount(1);
    await expect(app.locator(`.tree .grp[data-project="${home}"]`)).toHaveCount(0);
    // The fake agent writes no transcript: it is written as Claude would, so the shot shows the sent turn, working.
    const s = sessions(core).find((x) => x.id === id)!;
    const file = core.transcriptPath(s);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: PROMPT } }) + '\n');
    core.hook(id, 'UserPromptSubmit', { prompt: PROMPT });
    await expect(app.locator('.chat, [data-chat]').getByText(PROMPT).first()).toBeVisible({ timeout: 15_000 });
    await app.waitForTimeout(1000);
    await shot(app, 'c7-frame2-session');
  });

  test('t1_no_history_choose_folder: the line\'s "Choose folder…" is one click; the picked folder is chosen, Assistants stays in the list', async ({ app, core }) => {
    const picked = core.project('picked');
    await app.addInitScript((a) => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async (cmd: string) => (cmd === 'plugin:dialog|open' ? a : null) };
    }, picked);
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await quick(app).locator('[data-field="home-line"]').getByRole('button', { name: 'Choose folder…' }).click({ timeout: 15_000 });
    await expect(folder).toHaveValue(picked);
    await expect(folder.locator('option')).toHaveText([`picked (${picked})`, /^Assistants \(/, 'Choose folder…']);
    await expect(quick(app).locator('[data-field="home-line"]')).toHaveCount(0);
  });
});

test.describe('first run, with agent history', () => {
  test.use({ firstRun: true, colorScheme: 'light' });

  test('t1_history_unchanged: with Claude history the list is the history folders and Choose folder…, no Assistants row or line', async ({ app, core }) => {
    const project = core.project('my-app');
    const dir = path.join(core.home, 'claude-home/projects', project.replaceAll('/', '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'my-app.jsonl'), JSON.stringify({ type: 'user', cwd: project, message: { role: 'user', content: 'hello' } }) + '\n');
    await app.goto('/');
    const folder = quick(app).getByRole('combobox', { name: 'Folder' });
    await expect(folder).toHaveValue(project, { timeout: 15_000 });
    await expect(folder.locator('option')).toHaveText([`my-app (${project})`, 'Choose folder…']);
    await expect(quick(app).locator('[data-field="home-line"]')).toHaveCount(0);
  });
});
