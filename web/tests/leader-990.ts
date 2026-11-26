// Ticket 990: what the leader specs share (leader-team-990, leader-room-990, leader-home-990).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { type Core, expect, nunchiro, openWindow } from './fixtures';
import { openSettings } from './settings-modal';

type Mate = { id: string; name: string; job?: string; kind?: string; project?: string; lead?: boolean };
export function mates(core: Core, list: Mate[]) {
  fs.mkdirSync(path.join(core.home, 'team'), { recursive: true });
  fs.rmSync(path.join(core.home, 'team', 'bots.json'), { force: true }); // ticket 1168: a home from before the move reads team.json
  fs.writeFileSync(path.join(core.home, 'team', 'team.json'), JSON.stringify({ version: 1, teammates: list.map((m) => ({ job: `${m.name}'s job.`, kind: 'claude', ...m })) }));
}
type StoredBot = { id: string; name: string; job: string; seat: { kind: string; project?: string }; agent: string; model: { rule: string; model?: string; effort?: string }; v1?: { project?: string; effort?: string; level?: string; level_max?: string; next_level?: string } };
/** The roster as the core keeps it (ticket 1168): `team/bots.json` once a change moved it there, read as the teammates
 *  `team_list` answers (team/bots.rs `Bot::teammate`); `team/team.json` before that; none: no teammate yet. */
export function roster<M = Mate>(core: Core): M[] {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(core.home, 'team', file), 'utf8'));
  const has = (file: string) => fs.existsSync(path.join(core.home, 'team', file));
  if (!has('bots.json')) return has('team.json') ? read('team.json').teammates : [];
  return (read('bots.json').bots as StoredBot[]).map((b) => {
    const acp = b.agent.startsWith('acp:');
    const pin = b.model.rule === 'pinned';
    const { level, level_max, next_level } = b.v1 ?? {};
    const out = {
      id: b.id,
      name: b.name,
      job: b.job,
      kind: acp ? 'acp' : b.agent,
      model: pin ? b.model.model : undefined,
      effort: pin ? b.model.effort : b.v1?.effort,
      project: b.seat.kind === 'lead' ? b.seat.project : b.v1?.project,
      lead: b.seat.kind !== 'none' || undefined,
      level,
      level_max,
      next_level,
      agent: acp ? b.agent.slice(4) : undefined,
    };
    return JSON.parse(JSON.stringify(out)) as M; // as the file would hold it: an unset field is absent
  });
}
export const sessions = (core: Core) => core.cli('snapshot', '--json').sessions as { id: string; label: string; project: string; cwd: string; kind: string; state: string; teammate?: string }[];
/** Settings > Team: an item of a teammate row's "⋯" menu (ticket 993: Edit and Remove live there). */
export async function mateMenu(body: Locator, name: string, item: 'Edit' | 'Remove') {
  await body.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await body.getByRole('menuitem', { name: item, exact: true }).click();
}
/** Settings > Team > Open: the core's team_open; resolves to the seat's session id. */
export async function openSeat(app: Page, core: Core, name: string) {
  await openSettings(app);
  await app.locator('.settings > nav button[data-page="team"]').click();
  await app.locator('.sbody').getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(app.locator('.settings')).toHaveCount(0);
  let id = '';
  await expect.poll(() => (id = sessions(core).find((s) => s.label === name && s.teammate && s.state === 'running')?.id ?? '')).not.toBe('');
  return id;
}


/** A fake Claude that prints its own token, so a spec can act as its seat (a lead making worktrees). Its input is read with
 *  no echo and no output, as Claude's raw-mode reader takes it: a seat's ~4.8 KB brief is plain input the holder must write
 *  within 100 ms (holder/local.rs). With `exec cat` and the terminal's echo the input waited on cat's start and on two
 *  copies of the output: on a loaded host team_open failed "terminal input blocked; 4192 of 4832 bytes delivered" and
 *  Settings stayed open (nightly 11-21b, 17 tests). The shell's own `read` loop that replaced it takes a byte per read,
 *  and beside other lanes (load 8 to 14) the same error came back, 3528 of 4800 bytes, 6 tests of one WebKit run (lane
 *  w69). The reader is node now: it prints the prompt itself, so it is already reading when the brief comes, a line per read. */
const TOKEN_CLAUDE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
stty -echo
exec '${process.execPath}' -e 'process.stdout.write("\\u276f \\nTOKEN=" + process.env.NUNCHIRO_TOKEN + ".\\n"); process.stdin.resume();'
`;
export const tokenClaude = (core: Core) => fs.writeFileSync(path.join(core.home, 'bin', 'claude'), TOKEN_CLAUDE, { mode: 0o700 });
export async function tokenOf(core: Core, id: string) {
  let token = '';
  await expect.poll(() => (token = /TOKEN=([^.\s]+)\./.exec(core.read(id))?.[1] ?? ''), { timeout: 15_000 }).not.toBe('');
  return token;
}
/** The CLI as the session that holds `token`. */
export const asSeat = (core: Core, token: string, ...args: string[]) => JSON.parse(nunchiro({ ...core.env, NUNCHIRO_TOKEN: token }, args));
/** A shell seat started by the session with `token` (its parent), printing its own token. */
export async function worker(core: Core, token: string, cwd: string, label: string) {
  const id = (asSeat(core, token, 'session', 'start', '--kind', 'shell', '--project', cwd, '--label', label, '--', '/bin/sh', '-c', 'printf "TOKEN=%s.\\n" "$NUNCHIRO_TOKEN"; exec cat').session as { id: string }).id;
  return { id, token: await tokenOf(core, id) };
}
export function repo(core: Core, name: string) {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
}
type Listed = { path: string; branch: string; team?: string };
export const made = (core: Core, token: string, project: string, branch: string) => (asSeat(core, token, 'worktree', 'create', '--project', project, '--branch', branch, '--no-focus').worktrees as Listed[]).find((w) => w.branch === branch)!;
/** One request on the owner socket (as tree-seed.ts): the window's own ops a spec needs before or beside the window. */
const OWNER = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, request] = [process.argv[1], JSON.parse(process.argv[2])];
const token = fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(); const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token, request }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { s.destroy(); process.stdout.write(b); } }); s.on('error', (e) => (console.error(String(e)), process.exit(1)));`;
export const owner = (core: Core, request: object) => JSON.parse(execFileSync(process.execPath, ['-e', OWNER, core.home, JSON.stringify(request)], { timeout: 10_000, encoding: 'utf8' }));

/** H2 ①: a project with a lead (Main, its seat open), two worktrees it made, a worker in the first, and one independent
 *  worktree the user made. */
export async function leaderScene(app: Page, core: Core) {
  tokenClaude(core);
  const project = repo(core, 'nunchiro');
  mates(core, [{ id: 'lead-main', name: 'Main', project, lead: true }]);
  core.shell(project, 'alpha');
  await openWindow(app, {}, core);
  const lead = await openSeat(app, core, 'Main');
  const token = await tokenOf(core, lead);
  const ssh = made(core, token, project, 'ssh-retry');
  const palette = made(core, token, project, 'palette');
  const docs = (core.cli('worktree', 'create', '--project', project, '--branch', 'docs', '--no-focus').worktrees as Listed[]).find((w) => w.branch === 'docs')!;
  const sshWorker = await worker(core, token, ssh.path, 'ssh-retry');
  return { project, lead, token, ssh, palette, docs, sshWorker };
}

/** Owner 11-17: the lead's header chip opens the place's Team view (the right sidebar by default); resolves to that view. */
export async function openTeam(app: Page) {
  await app.locator('.shead [data-team-chip]').click();
  const view = app.locator('.sbar[data-widget="team"] .teamv');
  await expect(view).toBeVisible();
  return view;
}
