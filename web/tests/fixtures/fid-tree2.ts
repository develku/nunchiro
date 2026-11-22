import type { Page } from '@playwright/test';
import type { Patch } from '../visual/compare';
import { repo, worktree } from '../visual/compare';
import type { Core } from '../fixtures';
import { openQuiet, seed } from '../tree-seed';

export type TreePatch = Omit<Patch, 'waiting'> & { waiting?: Patch['waiting'] | true; pr?: { number: number; state: 'open' | 'merged' | 'checks_fail' }; kind?: 'background' };

/** Real core sessions and worktrees, with deterministic transcript/PR observations at the window boundary. */
export async function treeObservations(app: Page, patches: Record<string, TreePatch>) {
  const requests: { op: string; operation?: string; path?: string }[] = [];
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const labels = new Map<string, string>();
    const chips = new Map<number, TreePatch['pr']>();
    ws.onMessage((raw) => {
      const r = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (r?.request) requests.push(r.request);
      if (r?.request?.op === 'pr_chip') chips.set(r.id, patches[labels.get(r.request.id) ?? '']?.pr);
      server.send(raw);
    });
    server.onMessage((raw) => {
      if (typeof raw !== 'string') return ws.send(raw);
      const msg = JSON.parse(raw);
      if (chips.has(msg.id)) {
        const pr = chips.get(msg.id);
        chips.delete(msg.id);
        return ws.send(JSON.stringify({ id: msg.id, response: { Ok: { type: 'pr_chip', chip: pr ? { state: pr.state, url: `https://github.com/acme/app/pull/${pr.number}`, at: null } : null } } }));
      }
      if (msg.event === 'snapshot') for (const s of msg.sessions ?? []) {
        labels.set(s.id, s.label);
        const p = patches[s.label];
        if (!p) continue;
        Object.assign(s.attention, { working: !!p.working, failed: !!p.failed, waiting: !!p.waiting, stale: false });
        s.pending = typeof p.waiting === 'string' || p.kind ? [{ id: `d-${s.id}`, session_id: s.id, scope: s.project, kind: p.kind ?? p.waiting, text: p.text ?? 'git push', choices: [], observed_at: 1000, actionable: true, risky: false }] : [];
      }
      ws.send(JSON.stringify(msg));
    });
  });
  return requests;
}

/** Five independent states: lumen in ② and lumen inside Trading in ③ are different mockup frames. */
export function foldingFrame(core: Core, section: number): Record<string, TreePatch> {
  if (section === 1) {
    const p = repo(core, 'nunchiro');
    core.shell(p, 'main');
    for (const name of ['v2-undo', 'v2-theme', 'v2-spaces', 'v2-palette', 'shipped', 'old-work']) worktree(core, p, name);
    return { 'v2-undo': { waiting: 'permission', text: 'git push' }, 'v2-theme': { waiting: 'question', text: 'palette A or B?' }, 'v2-spaces': { failed: true }, 'v2-palette': { working: true, pr: { number: 53, state: 'open' } }, shipped: { pr: { number: 51, state: 'merged' } }, 'old-work': { pr: { number: 52, state: 'merged' } } };
  }
  if (section === 2) {
    const p = repo(core, 'lumen');
    core.shell(p, 'main');
    for (const name of ['lcfollow', 'working', 'merged', 'idle']) worktree(core, p, name);
    return { lcfollow: { waiting: 'permission', text: 'npm install' }, working: { working: true }, merged: { pr: { number: 52, state: 'merged' } } };
  }
  if (section === 3) {
    const k = repo(core, 'lumen');
    for (const name of ['rehfix', 'broke', 'tests']) worktree(core, k, name);
    core.shell(k, 'main');
    const s = repo(core, 'tide');
    for (const name of ['sealed-read', 'review']) worktree(core, s, name);
    core.shell(s, 'main');
    const b = repo(core, 'blog');
    for (const name of ['post', 'draft', 'open-pr']) worktree(core, b, name);
    seed(core, { op: 'group_create', name: 'Trading', project: k }, { op: 'project_move', project: s, group: 'Trading' }, { op: 'project_move', project: b, group: 'Trading' });
    return { rehfix: { waiting: 'permission', text: 'git push' }, 'sealed-read': { waiting: 'question', text: 'keep or drop index?' }, post: { waiting: 'permission' }, broke: { failed: true }, tests: { working: true }, review: { working: true }, draft: { pr: { number: 52, state: 'merged' } }, 'open-pr': { pr: { number: 53, state: 'open' } } };
  }
  const p = repo(core, 'blog');
  core.shell(p, 'main');
  worktree(core, p, 'post');
  openQuiet(core);
  return { post: { working: true } };
}
