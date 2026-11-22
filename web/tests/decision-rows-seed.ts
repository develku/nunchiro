// V2-8e: helpers for decision-rows.spec.ts. Fake agents (queue.spec.ts's fake, unchanged) draw a prompt once their
// trigger file exists; the window's socket is proxied so every `answer` request is recorded (and still reaches the
// core), and an item may be patched with the fields the core sets from hook data a fake cannot give.
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, REPO, type Core } from './fixtures';

const FAKE = `#!/bin/sh
if [ "$1" = --version ]; then echo '2.1.310 (Claude Code)'; exit; fi
go=""; prev=""
for a in "$@"; do [ "$prev" = --model ] && go="$a"; prev="$a"; done
printf 'fake agent ready\\r\\n'
while [ ! -s "$go" ]; do sleep 0.02; done
draw() { printf '\\033[2J\\033[H'; cat "$go"; }
trap draw WINCH
draw
until read x; do :; done
printf '\\033[2J\\033[Hanswered %s\\r\\n' "$x"
sleep 600
`;
export const PERMISSION = (cmd: string) => `Bash command\r\n\r\n  ${cmd}\r\n\r\nDo you want to proceed?\r\n> 1. Yes\r\n  2. No\r\n`;
export const QUESTION = 'Red or blue?\r\n> 1. red\r\n  2. blue\r\n  3. Always pick red from now on\r\nEnter to select · Esc to cancel\r\n';

export function fakes(core: Core) {
  const bin = JSON.stringify(path.join(REPO, 'target/debug/nunchiro'));
  fs.writeFileSync(path.join(core.home, 'bin/claude'), FAKE.replace('#!/bin/sh\n', `#!/bin/sh\nNUNCHIRO_TEST_BIN=${bin}\n`), { mode: 0o700 });
}
/** Shows `screen` in the fake agent whose folder is `dir` (written whole, so the fake never reads half). */
export function show(dir: string, trigger: string, screen: string) {
  const tmp = path.join(dir, `.${trigger}.tmp`);
  fs.writeFileSync(tmp, screen);
  fs.renameSync(tmp, path.join(dir, trigger));
}
export const gitRepo = (core: Core, name: string) => {
  const p = core.project(name);
  const git = (...a: string[]) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a]);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return p;
};
export const pending = (core: Core) =>
  core.cli('snapshot', '--json').sessions.flatMap((s: { pending: { id: string; session_id: string }[] }) => s.pending) as { id: string; session_id: string }[];

type Item = Record<string, unknown> & { id: string; text: string; session_id: string };
export interface Proxy {
  /** Every `answer` request the window sent, in order, with the session of its item (an item may be re-filed under a
   * new id when its prompt redraws, so tests compare sessions). */
  sent: { item: string; session?: string; answer: { type: string; text?: string; index?: number } }[];
  /** Labels whose items stay risky as the core files them; every other session's items are marked safe. */
  risky: Set<string>;
  /** While true, answers are recorded and acknowledged here, never sent on: the item stays pending in the core. */
  hold: boolean;
  /** Changes an item of the snapshot the window sees (the core's own snapshot is untouched). */
  patch: (f: (d: Item, session: { id: string; label: string }) => Item[] | void) => void;
}

/** A screen-only fake item is risky in the core (no hook tool): items are marked safe here, as the core marks a hooked
 * command inside the folder, except for sessions listed in `risky`. */
export async function proxy(app: Page): Promise<Proxy> {
  const out: Proxy = { sent: [], risky: new Set(), hold: false, patch: () => {} };
  const owner = new Map<string, string>();
  // Items this proxy marked safe: the core still files them risky (no hook data), so their allow is forwarded as the
  // core would take a safe item's (confirmed), keeping window and core in agreement.
  const safe = new Set<string>();
  let edit: (d: Item, s: { id: string; label: string }) => Item[] | void = () => {};
  const sockets: { send(m: string): void }[] = [];
  let last = '';
  const apply = (raw: string) => {
    const msg = JSON.parse(raw);
    for (const s of msg.sessions ?? [])
      s.pending = (s.pending as Item[]).flatMap((d) => {
        if (!out.risky.has(s.label)) {
          d.risky = false;
          safe.add(d.id);
        }
        const all = edit(d, s) ?? [d];
        for (const x of all) owner.set(x.id, s.id);
        return all;
      });
    return JSON.stringify(msg);
  };
  out.patch = (f) => {
    edit = f;
    if (last) for (const ws of sockets) ws.send(apply(last));
  };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    sockets.push(ws);
    ws.onMessage((m) => {
      if (typeof m === 'string') {
        const f = JSON.parse(m);
        if (f.request?.op === 'answer') {
          out.sent.push({ item: f.request.item, session: owner.get(f.request.item), answer: f.request.answer });
          if (out.hold) return ws.send(JSON.stringify({ id: f.id, response: { Ok: 'Ack' } }));
          if (safe.has(f.request.item) && f.request.answer?.type === 'allow_once') return server.send(JSON.stringify({ ...f, request: { ...f.request, confirmed: true } }));
        }
      }
      server.send(m);
    });
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"event":"snapshot"')) ws.send(apply((last = m)));
      else ws.send(m);
    });
  });
  return out;
}

/** Ticket 1030: the session in front answers its ordinary request on a card above its composer, not in Decisions. A spec
 *  about the Decisions card closes the session's tab first (the session and its tree row stay), so it is in the background. */
export async function behind(app: Page, id: string) {
  const tab = app.locator('.tabw').filter({ has: app.locator(`.tab[data-tab="${id}"]`) });
  await expect(tab).toBeVisible({ timeout: 8000 });
  await tab.hover();
  await tab.locator('button.x').click();
  await expect(tab).toHaveCount(0);
}
/** Ticket 1030: closes every session tab (sessions and tree rows stay), so no session is in front. */
export async function noFront(app: Page) {
  const tabs = app.locator('.tabw[data-menu="tab"]');
  await expect(tabs.first()).toBeVisible({ timeout: 8000 });
  for (let n = await tabs.count(); n > 0; n--) {
    await tabs.first().hover();
    await tabs.first().locator('button.x').click();
    await expect(tabs).toHaveCount(n - 1);
  }
}
