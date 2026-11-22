// The core cannot make a session wait or fail on demand: the window's socket is proxied and sessions are patched by label
// (as conformance-2.spec.ts and visual/compare.ts do).
import type { Page } from '@playwright/test';

export async function patch(app: Page, patches: Record<string, 'waiting' | 'failed'>) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((raw) => {
      if (typeof raw !== 'string' || JSON.parse(raw).event !== 'snapshot') return ws.send(raw);
      const msg = JSON.parse(raw);
      for (const s of msg.sessions ?? []) {
        const p = patches[s.label];
        if (p === 'failed') Object.assign(s.attention, { working: false, stale: false, failed: true, waiting: false });
        if (p !== 'waiting') continue;
        Object.assign(s.attention, { working: false, stale: false, failed: false, waiting: true, last_activity: Date.now() - 600_000 });
        s.pending = [{ id: `d-${s.label}`, session_id: s.id, scope: s.project, kind: 'permission', text: `Run ${s.label}?`, choices: [], observed_at: Date.now() - 120_000, actionable: true, risky: false }];
      }
      ws.send(JSON.stringify(msg));
    });
  });
}
