// Ticket 582 follow-up (scorecard F1): every onboarding step that reads Done also says what it did. The walk makes each
// step done, then fails when a done step has no non-empty status line, and checks the three lines that used to be missing
// (look, macos, skills) for the result they name. The app shell is a fake `__TAURI_INTERNALS__` (the macOS step exists only there).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type Core } from './fixtures';
import { mates } from './leader-990';

const CLAUDE = `#!/bin/sh
case "$1 $2" in "--version ") echo '2.1.311 (Claude Code)'; exit 0;; "auth status") echo '{"loggedIn": true}'; exit 0;; esac
printf 'fake agent ready\\r\\n'
exec /bin/cat
`;
// The turn hooks a real Claude sends over the owner socket (as first-use-walk.spec.ts): a finished turn is what the session step reads.
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
const turn = (core: Core, id: string) => {
  for (const event of ['UserPromptSubmit', 'Stop']) execFileSync(process.execPath, ['-e', HOOK, core.home, id, event], { encoding: 'utf8', timeout: 10_000 });
};

const step = (app: Page, id: string) => app.locator(`.ob-step[data-step="${id}"]`);
const nav = (app: Page) => app.getByRole('navigation', { name: 'Settings pages' });
const panel = (app: Page) => app.locator('.ob-panel');

test.use({ firstRun: true });

test('onboarding_every_done_step_says_what_it_did', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), CLAUDE, { mode: 0o700 });
  turn(core, core.agent(core.project('demo'), 'alpha', 'x').id);
  mates(core, [{ id: 'mate-chief', name: 'Chief', lead: true }]); // ticket 1034: the assistant step is done once Home has its lead
  await app.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === 'permission_status' ? { full_disk: true, volumes: 'not_granted' } : cmd === 'notification_permission' ? 'granted' : null),
      transformCallback: () => 0,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
    };
  });
  await app.goto('/');
  await expect(app.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await app.keyboard.press('Meta+Comma'); // a window with a session does not open Settings by itself
  await nav(app).locator('button[data-page="onboarding"]').click();
  const steps = ['look', 'providers', 'notify', 'keys', 'project', 'macos', 'skills', 'assistant', 'session']; // ticket 1034: the assistant step
  // The project step names a project only when its own Add project added it (tickets 472, 479; onboarding-tail.spec.ts), so it is not asked for a line here.
  const named = steps.filter((id) => id !== 'project');
  await expect(app.locator('.ob-step')).toHaveCount(steps.length);

  // The look and macos steps are done once their page was seen.
  for (const [id, page] of [['look', 'appearance'], ['macos', 'permissions']]) {
    await step(app, id).click();
    await panel(app).locator(`[data-go="${page}"]`).click();
    await nav(app).locator('button[data-page="onboarding"]').click();
  }

  const lines: Record<string, string> = {};
  for (const id of steps) {
    await step(app, id).click();
    // The panel follows the click a render later; without this wait an already-done step read the previous panel's line.
    await expect(panel(app)).toHaveAttribute('data-panel', id);
    await expect(step(app, id), `${id} is done`).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
    if (!named.includes(id)) continue;
    const line = panel(app).getByRole('status').filter({ hasText: /\S/, hasNotText: /^Reading/ }).first(); // the skills panel first says it is reading
    await expect(line, `${id} is done but says nothing about what it did`).toBeVisible();
    lines[id] = (await line.innerText()).trim();
  }

  expect(lines.look).toBe('Theme: Follow the system. Row height: 32 px. Language: System.'); // ticket 1041: the A+B+C default row
  expect(lines.keys).toBe('Prefix ⌃. or ⌃␣ · hint keys asdfjklghewruiopqtyvcmnxzb1234567890');
  expect(lines.macos).toBe('Full Disk Access: Granted. Removable volumes: Not granted.');
  expect(lines.skills).toBe('Hooks: On. Skills on: 2.');
  expect(lines.assistant).toBe('Your assistant is Chief. It is in the tree under Assistants.');
});
