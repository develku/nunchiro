// Shared by agent-pane.spec.ts and agent-pane-shots.spec.ts.
import type { Page } from '@playwright/test';

/** Replaces one session's pending items in every snapshot frame the window gets; `push` re-sends the last one. */
export async function injectPending(page: Page) {
  const state: { items: Record<string, unknown[]>; last: unknown; push: () => void } = { items: {}, last: null, push: () => {} };
  const sockets: { send(m: string): void }[] = [];
  const patch = (msg: { sessions: { id: string; pending: unknown[] }[] }) => {
    for (const s of msg.sessions) if (state.items[s.id]) s.pending = state.items[s.id];
    return JSON.stringify(msg);
  };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    sockets.push(ws);
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      if (msg?.event !== 'snapshot') return ws.send(m);
      state.last = structuredClone(msg);
      ws.send(patch(msg));
    });
  });
  // The page holds more than one socket over a run (a reconnect) and a closed one takes a frame without complaint: send to all.
  state.push = () => {
    if (!state.last) return;
    for (const ws of sockets) ws.send(patch(structuredClone(state.last) as never));
  };
  return state;
}

/** A pending item as the core serialises it (`sources` is a set of detector names). */
export const item = (session: string, kind: string, sources: string[]) => ({
  id: `d-${kind}-${sources.join('')}`,
  session_id: session,
  scope: 'x',
  kind,
  text: 'Pick a model',
  choices: [],
  sources,
  observed_at: Date.now(),
  actionable: false,
  reconciled: false,
  screen_text: 'Pick a model\n1. a\n2. b',
});

/** v25-shell-chrome (ticket 284 item 4): the side pane has no tab strip. A shell, Preview and maximise are palette commands; Browser
 *  and the PTY are reached from the Right bar's icons (Browser, Terminal). */
export async function paletteCommand(page: Page, text: string) {
  await page.keyboard.press('Meta+KeyK');
  await page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill(text);
  await page.keyboard.press('Enter');
}
export const showPreview = (page: Page) => paletteCommand(page, 'Show or hide Preview');
export const newShell = (page: Page) => paletteCommand(page, 'New shell in the side pane');
export const maximisePane = (page: Page) => paletteCommand(page, 'Maximize or restore the side pane');
/** What each side pane view draws (the tab it replaced is gone). */
export const bview = (page: Page) => page.locator('[data-side-pane] .bview');
export const pview = (page: Page) => page.locator('[data-side-pane] .pprev');
