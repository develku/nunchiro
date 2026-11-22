// V2.5-37 (ticket 185): board.json seeds with 184's task fields for the draft B board tests, and a WebSocket overlay for
// what a test cannot make a real core do on cue (an attached agent asking, a PR, and `board_undo`, which ticket 183 routes).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, REPO, type Core } from '../../fixtures';

/** A shell in a turn: its prompt was sent and no Stop came (ticket 407: a quiet shell is idle, not working). */
export function busyShell(core: Core, project: string, label: string) {
  return core.shell(project, label, '/bin/sh', '-c', `printf '{}' | '${path.join(REPO, 'target/debug/nunchiro')}' hook UserPromptSubmit; exec cat`);
}

/**
 * Ticket 407: the watch view shows a session under Working only while it is in a turn, as the tree's dot does. The
 * fixture's fake agent never sends a hook, so it is idle; after this call every agent the test starts sends
 * UserPromptSubmit first (its prompt went out, no Stop came) and so is working.
 */
export function agentsInTurn(core: Core) {
  const bin = path.join(core.home, 'bin/claude');
  const hook = `printf '{}' | '${path.join(REPO, 'target/debug/nunchiro')}' hook UserPromptSubmit >/dev/null 2>&1\n`;
  const fake = fs.readFileSync(bin, 'utf8');
  const at = fake.indexOf("printf 'fake agent ready");
  if (at < 0) throw new Error('the fake agent changed: agentsInTurn finds no ready line');
  fs.writeFileSync(bin, fake.slice(0, at) + hook + fake.slice(at));
}

export const FIVE = [
  { id: 'todo', title: 'To do', states: [], needs_decision: false, proof: false },
  { id: 'working', title: 'Working', states: ['working'], needs_decision: false, proof: false },
  { id: 'needs-decision', title: 'Needs decision', states: ['needs_decision'], needs_decision: true, proof: false },
  { id: 'review', title: 'Review', states: ['review'], needs_decision: false, proof: false },
  { id: 'done', title: 'Done', states: ['done'], needs_decision: false, proof: true },
];

export interface Seed {
  id: string;
  title: string;
  column: string;
  group?: string;
  ref?: string;
  receipt?: { sha: string; command: string; result: string } | null;
  waits_on?: string[];
  attachments?: { session_id: string; role: string }[];
  /** Minutes since the last column change (default 1). */
  moved?: number;
  history?: { at?: number; actor: string; kind: string; from: string | null; to: string; reason?: string | null }[];
  session_id?: string | null;
}

const MIN = 60_000;
/** Writes board.json with these manual cards (the store's version-1 shape, 184's task fields). */
export function seed(core: Core, cards: Seed[]) {
  const now = Date.now();
  const manual = cards.map((c) => {
    const moved = now - (c.moved ?? 1) * MIN;
    return {
      id: c.id,
      title: c.title,
      note: '',
      session_id: c.session_id ?? null,
      column: c.column,
      updated_at: moved,
      group: c.group ?? '',
      ref: c.ref ?? '',
      receipt: c.receipt ?? null,
      waits_on: c.waits_on ?? [],
      attachments: c.attachments ?? [],
      last_moved_at: moved,
      history: (c.history ?? [{ actor: 'owner', kind: 'create', from: null, to: c.column }]).map((h, i) => ({ reason: null, ...h, at: h.at ?? moved - (10 - i) * MIN })),
    };
  });
  fs.writeFileSync(path.join(core.home, 'board.json'), JSON.stringify({ version: 1, columns: FIVE, config_stamp: null, config_error: null, manual }));
}

type Json = Record<string, unknown>;
export interface Overlay {
  /** Changes each board reply (snapshot or write) before the window sees it. */
  board?: (board: Json) => Json;
  /** Answers a request op here instead of the core (the reply's `Ok` body). */
  ops?: Record<string, (request: Json) => Json>;
  /** Sends the core another request in place of this op (its reply still passes `board`). */
  forward?: Record<string, (request: Json) => Json>;
  /** Ops sent nowhere and never answered (a core that drops a frame). */
  drop?: string[];
}

export async function overlay(app: Page, o: Overlay) {
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      if (typeof msg !== 'string') return server.send(msg);
      const r = JSON.parse(msg);
      if (o.drop?.includes(r.request?.op)) return;
      const own = r.request?.op && o.ops?.[r.request.op];
      if (own) return ws.send(JSON.stringify({ id: r.id, response: { Ok: own(r.request) } }));
      const swap = r.request?.op && o.forward?.[r.request.op];
      server.send(swap ? JSON.stringify({ ...r, request: swap(r.request) }) : msg);
    });
    server.onMessage((msg) => {
      if (typeof msg !== 'string' || !o.board) return ws.send(msg);
      const r = JSON.parse(msg);
      const ok = r.response?.Ok;
      if (ok?.type === 'board_snapshot' && ok.board) ok.board = o.board(ok.board);
      ws.send(JSON.stringify(r));
    });
  });
}

/** Opens the window and the board from its visible, labelled control on the right bar (one click). */
export async function openBoard(app: Page, core?: Core) {
  await openWindow(app, {}, core);
  await app.locator('.ib.r').getByRole('button', { name: /^Board( · |$)/ }).click(); // the name carries the needs-you count
  const board = app.locator('.board');
  await expect(board).toBeVisible();
  await app.mouse.move(2, 2); // the board holds still while the pointer is over it (needs 26)
  return board;
}

export const cardOf = (app: Page, title: string) => app.locator('.board .bcard').filter({ has: app.locator('.btt', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
