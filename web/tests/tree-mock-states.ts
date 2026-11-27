// Ticket 462: the approved mockup's (docs/design/m3-1110/388.html) sessions in the app's tree, for tree-bars-462.spec.ts.
import type { Page } from '@playwright/test';
import type { Core } from './fixtures';
import { seed } from './tree-seed';

// The tree is a pure view of the snapshot: patch each session's attention by label (as tree-strip-411.spec does), and
// `wt` moves a session into a worktree folder of its project (a row of its own, not the main folder's "N done"). Patches
// apply after the window opened (`openWindow` counts the running sessions' tabs).
export type Patch = { limited?: boolean; failed?: boolean; waiting?: boolean; stale?: boolean; working?: boolean; exited?: boolean; resumable?: boolean; wt?: boolean; machine?: string; ask?: 'permission' | 'question'; at?: number };
export async function patchSnapshots(app: Page) {
  let patches: Record<string, Patch> = {};
  let last = '';
  const sockets: { send(m: string): void }[] = [];
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? []) {
      const p = patches[s.label];
      if (!p) continue;
      // Every flag the row reads is the patch's, input_blocked too: a fake seat whose brief write was slow on a loaded runner
      // read as "not reading input" (failed), and a face patched to working stayed at rest (bots-1168, hosted WebKit).
      Object.assign(s.attention, { working: !!p.working, stale: !!p.stale, failed: !!p.failed, waiting: !!p.waiting, input_blocked: false, last_activity: p.at ?? Date.now() - 600_000 });
      if (p.at !== undefined && s.ended_at !== undefined) s.ended_at = p.at; // lane w59: an ended run's own stamp follows the time the patch gives it
      if (p.exited) s.state = 'exited';
      if (p.limited) s.limit = { resets: '14:30', until: Date.now() + 3_600_000 }; // ticket 1041: a usage limit (ticket 372)
      if (p.resumable) s.state = 'resumable';
      if (p.machine) s.machine = p.machine;
      if (p.wt) s.cwd = `${s.project}/.wt/${s.label.replace(/\W/g, '-')}`;
      if (p.waiting) s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: p.ask ?? 'question', text: `Run ${s.label}?`, choices: ['1. red', '2. blue'].map((label, i) => ({ label, keys: [String(i + 1)], changes_settings: false })), observed_at: p.at ?? Date.now() - 180_000, actionable: true, risky: false }];
    }
    return JSON.stringify(msg);
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(typeof m === 'string' && JSON.parse(m).event === 'snapshot' ? apply((last = m)) : m));
  });
  return (p: Record<string, Patch>) => {
    patches = p;
    if (last) for (const ws of sockets) ws.send(apply(last));
  };
}

/** The mockup's sessions (its `KM`, `NU`, `KV`, `SM`, `BL`, `KR`), in the app's words and its project order. `rehfix` waited
 * longest and asks for a permission (the mockup's hand), `sealed-read` asks a question. */
export const STATES: Record<string, Record<string, Patch>> = {
  // dotfiles: r1 y2 g2 and "2 done"
  dotfiles: { 'claude 3a964f': { failed: true }, 'shell 747cf3': {}, 'st-1': { stale: true }, 'st-2': { stale: true }, 'idle-1': {}, 'd-done-1': { exited: true }, 'd-done-2': { exited: true } },
  // nunchiro: "3 done" (main folder, finished) + claude a5b463 and acp 452d64 resting on their own rows: g2
  nunchiro: { 'n-done-1': { exited: true }, 'n-done-2': { exited: true }, 'n-done-3': { exited: true }, 'claude a5b463': { exited: true, wt: true }, 'acp 452d64': { exited: true, wt: true } },
  // lumen: r1 o1 b1 g1 (notes rests on its own row)
  lumen: { rehfix: { waiting: true, ask: 'permission', at: Date.now() - 900_000 }, 'feed-retry': { failed: true }, 'bt-sweep': { working: true }, notes: { exited: true, wt: true } },
  // tide: o1 b2
  tide: { 'sealed-read': { waiting: true }, 'w-1': { working: true }, 'w-2': { working: true } },
  // blog: g3
  blog: { 'b-1': {}, 'b-2': {}, 'b-3': {} },
  // lumen-remote on the MacBook: b1 g2. The tree has no machine sections yet (tree.ts buildTree: every session is listed
  // under this Mac), so its head shows among This Mac's projects; its strip is what is compared.
  'lumen-remote': { 'kr-work': { working: true, machine: 'MacBook' }, 'kr-1': { machine: 'MacBook' }, 'kr-2': { machine: 'MacBook' } },
};

export async function mockTree(app: Page, core: Core) {
  for (const [project, sessions] of Object.entries(STATES)) {
    const dir = core.project(project);
    for (const label of Object.keys(sessions)) core.shell(dir, label);
  }
  const at = (n: string) => core.project(n);
  seed(core, { op: 'group_create', name: 'Trading', project: at('lumen') }, { op: 'project_move', project: at('tide'), group: 'Trading' }, { op: 'project_move', project: at('blog'), group: 'Trading' }, { op: 'fold', key: 'group:Trading', folded: true });
  const set = await patchSnapshots(app);
  return () => set(Object.assign({}, ...Object.values(STATES)));
}
