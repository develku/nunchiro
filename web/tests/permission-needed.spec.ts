// v1a-33: a session whose folder the core could not open shows "Permission needed" over its terminal.
import fs from 'node:fs';
import path from 'node:path';
import { PANE_URLS } from '../src/features/macos-perms';
import { canRestart, restartStart, SETTINGS_URLS } from '../src/PermissionNeeded';
import { restartRequest } from '../src/chrome/restart';
import type { Session } from '../src/types';
import { expect, openWindow, REPO, test, type Core } from './fixtures';

type Snap = Session & { blocked?: { reason: string; path: string }; model?: string; effort?: string };
const snapshot = (core: Core) => core.cli('snapshot', '--json').sessions as Snap[];

/** A project the core can enter but not list: opendir fails with EACCES, the probe's refusal. */
function lockedProject(core: Core) {
  const project = core.project('locked');
  fs.chmodSync(project, 0o100);
  return project;
}

test('a blocked session shows Permission needed with Open Settings and Restart session', async ({ app, core }) => {
  const project = lockedProject(core);
  try {
    const trigger = 'never';
    const old = core.cli('session', 'start', '--kind', 'claude', '--project', project, '--label', 'ext', '--model', trigger, '--effort', 'high').session as Snap;
    await expect.poll(() => snapshot(core)[0].blocked, { timeout: 10_000 }).toEqual({ reason: 'file_access', path: project });
    await openWindow(app);
    const panel = app.getByRole('region', { name: 'Permission needed' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('macOS has not allowed Nunchiro to read this folder');
    await expect(panel).toContainText(project);
    await expect(panel).toContainText('Removable Volumes');
    await expect(panel).toContainText('Full Disk Access');
    await expect(panel.getByRole('button', { name: 'Open Settings' })).toBeVisible();
    // The agent keeps running behind the panel.
    expect(snapshot(core)[0]).toMatchObject({ state: 'running', pid: old.pid });

    await panel.getByRole('button', { name: 'Restart session' }).click();
    await expect.poll(() => snapshot(core).length).toBe(2);
    const after = snapshot(core);
    const closed = after.find((s) => s.id === old.id)!;
    const next = after.find((s) => s.id !== old.id)!;
    expect(closed.state).toBe('closed');
    // No finished turn yet: `claude --resume` of a conversation never written fails, so it starts fresh.
    expect(next).toMatchObject({ state: 'running', kind: 'claude', project, label: 'ext', model: trigger, effort: 'high' });
    expect(next.agent_session_id).not.toBe(old.agent_session_id);
    // The tab follows the new session; it is blocked too while the folder stays locked.
    await expect(app.locator(`.tab[data-tab="${next.id}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(app.locator(`.tab[data-tab="${old.id}"]`)).toHaveCount(0);
    await expect(panel).toBeVisible();
  } finally {
    fs.chmodSync(project, 0o700);
  }
});

test('a blocked shell session shows no Restart, only where to start it again', async ({ app, core }) => {
  const project = lockedProject(core);
  try {
    core.shell(project, 'sh', '/bin/cat');
    await expect.poll(() => snapshot(core)[0].blocked, { timeout: 10_000 }).toEqual({ reason: 'file_access', path: project });
    await openWindow(app);
    const panel = app.getByRole('region', { name: 'Permission needed' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(`Close this session and start it again in ${path.basename(project)} after the grant.`);
    // Ticket 553: two folders with the same name are told apart by the full path on hover.
    await expect(panel.locator('code', { hasText: new RegExp(`^${path.basename(project)}$`) })).toHaveAttribute('title', project);
    await expect(panel.getByRole('button', { name: 'Restart session' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Open Settings' })).toBeVisible();
  } finally {
    fs.chmodSync(project, 0o700);
  }
});

test('Restart starts again in the session\'s own folder: a worktree session stays in its worktree (ticket 991, A1)', () => {
  const base = { id: 'a', kind: 'claude', project: '/p', cwd: '/p', label: 'x', state: 'running', agent_session_id: 'conv', side_chat: false } as Session;
  const worktree = { ...base, cwd: '/wt/p/w' } as Session;
  expect(canRestart(base)).toBe(true);
  expect(canRestart(worktree)).toBe(true); // a fresh start now runs in the worktree, not in the project
  expect(restartStart(worktree)).toMatchObject({ project: '/wt/p/w', resume: null });
  expect(restartStart({ ...worktree, completion_seq: 2 } as Session)).toMatchObject({ project: '/p', resume: 'conv' }); // the core resumes in the run's folder
  // A shell came back in the main checkout under the worktree's name: it starts in its own folder now.
  expect(restartRequest({ ...worktree, kind: 'shell', agent_session_id: null, state: 'exited' } as Session)).toMatchObject({ kind: 'shell', project: '/wt/p/w' });
  expect(canRestart({ ...base, kind: 'shell', agent_session_id: null } as Session)).toBe(false); // a shell restarts through the tab menu, plain
});

test('a session without blocked renders as today', async ({ app, core }) => {
  const s = core.shell(core.project('demo'), 'alpha');
  await openWindow(app);
  await expect(app.locator(`.term[data-session="${s.id}"]`)).toBeVisible();
  await app.waitForTimeout(2500); // past the core's 2 s probe bound
  expect(snapshot(core)[0].blocked).toBeUndefined();
  await expect(app.getByRole('region', { name: 'Permission needed' })).toHaveCount(0);
});

test('restart resumes a conversation that has one, and keeps agent, folder, model and effort', () => {
  const base = { id: 'a', kind: 'claude', project: '/p', cwd: '/p', label: 'x', state: 'running', agent_version: null, untested: false, pid: 1, pending: [] } as unknown as Session;
  const turn = { ...base, agent_session_id: 'conv-1', completion_seq: 2, model: 'haiku', effort: 'low' } as Session;
  expect(restartStart(turn)).toEqual({ kind: 'claude', project: '/p', label: 'x', model: 'haiku', effort: 'low', resume: 'conv-1' });
  // Claude gets its id at launch; without a finished turn there may be no conversation to resume.
  expect(restartStart({ ...turn, completion_seq: 0 } as Session).resume).toBeNull();
  // Codex reports its id only once the conversation exists.
  expect(restartStart({ ...turn, kind: 'codex', completion_seq: 0 } as Session).resume).toBe('conv-1');
  expect(restartStart({ ...base, kind: 'codex', agent_session_id: null } as Session)).toMatchObject({ resume: null, model: null, effort: null });
});

test('Open Settings opens only the System Settings URLs the window capability allows', () => {
  const cap = JSON.parse(fs.readFileSync(path.join(REPO, 'app/src-tauri/capabilities/default.json'), 'utf8'));
  const allow = cap.permissions.find((p: { identifier?: string }) => p.identifier === 'opener:allow-open-url').allow.map((a: { url: string }) => a.url);
  // Glob patterns: `[?]` is a literal question mark; no wildcard for the settings scheme.
  const settings = allow.filter((u: string) => !u.startsWith('http'));
  const expected = [...new Set([...Object.values(SETTINGS_URLS), ...Object.values(PANE_URLS)])].sort();
  expect(settings.map((u: string) => u.replace('[?]', '?')).sort()).toEqual(expected);
  expect(settings.every((u: string) => !u.includes('*'))).toBe(true);
  expect(allow.filter((u: string) => u.startsWith('http'))).toEqual(['https://*', 'http://*']);
});
