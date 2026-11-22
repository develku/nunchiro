// The v2-8a mockup's own data as a live app tree (needs 130, FIDELITY BAR): a folded project lumen with a decision
// waiting in one worktree, a folded group Trading over lumen and tide, and a project with merged worktrees to clean up.
// fidelity-tree.spec.ts renders it at the mockup's width so the app and the mockup show the same rows.
import type { Page } from '@playwright/test';
import type { Core } from '../fixtures';
import { seed } from '../tree-seed';
import { repo, show, worktree, type Scheme } from '../visual/compare';

/** A fake agent's pending item; `risky` draws the mockup's "Caution" chip (a permission the window may not allow in place). */
export type Waiting = { waiting: 'permission' | 'question'; text: string; risky?: boolean };

/** patchSnapshots (visual/compare.ts) plus the risk flag, which that helper does not take. `chips` also answers every
 *  pr_chip request with a merged chip, so the same tree shows the clean-up line (a page allows one ws route). */
export async function riskPatches(app: Page, patches: Record<string, Waiting>, chips = false) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    const asked = new Set<number>();
    ws.onMessage((m) => {
      const r = typeof m === 'string' ? JSON.parse(m) : null;
      if (r?.request?.op === 'pr_chip') asked.add(r.id);
      server.send(m);
    });
    server.onMessage((raw) => {
      if (chips) {
        const r = typeof raw === 'string' ? JSON.parse(raw) : null;
        if (r && asked.has(r.id)) return ws.send(JSON.stringify({ id: r.id, response: { Ok: { type: 'pr_chip', chip: { state: 'merged', url: 'https://github.com/acme/app/pull/52', at: null } } } }));
      }
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) {
        const p = patches[s.label];
        if (!p?.waiting) continue;
        Object.assign(s.attention, { working: false, stale: false, failed: false, waiting: true, last_activity: Date.now() - 600_000 });
        s.pending = [
          { id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: p.waiting, text: p.text, choices: [], observed_at: Date.now() - 120_000, actionable: true, risky: p.risky ?? false },
        ];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

export const MOCKUP_WAITING = 'npm test 실패 허용?';

/** lumen (main + backtest-runner waiting on a risky permission) and tide (main + sealed-read waiting on a question) in
 *  the group Trading; the group folded unless `fold` is false. With the group folded both projects fold with it (G2).
 *  `cleanup` adds a project whose two merged worktrees give the clean-up line, "Ready to clean up (2)" (mockup ①). */
export async function mockupTree(app: Page, core: Core, scheme: Scheme, fold = true, cleanup = false) {
  const k = repo(core, 'lumen');
  worktree(core, k, 'backtest-runner');
  core.shell(k, 'main');
  const s = repo(core, 'tide');
  worktree(core, s, 'sealed-read-backend');
  core.shell(s, 'main');
  if (cleanup) {
    const p = repo(core, 'nunchiro');
    for (const b of ['shipped', 'v2-spaces']) worktree(core, p, b);
  }
  seed(core, { op: 'group_create', name: 'Trading', project: k }, { op: 'project_move', project: s, group: 'Trading' }, ...(fold ? [{ op: 'fold', key: 'group:Trading', folded: true }] : []));
  await riskPatches(
    app,
    { 'backtest-runner': { waiting: 'permission', text: MOCKUP_WAITING, risky: true }, 'sealed-read-backend': { waiting: 'question', text: 'keep or drop index?' } },
    cleanup,
  );
  await show(app, scheme);
  return app.locator('.pgrp[data-group="Trading"]');
}

export const tree = (page: Page) => page.locator('aside[aria-label="Tree"]');
