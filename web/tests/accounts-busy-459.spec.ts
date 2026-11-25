// Ticket 459: the core refuses a request past a connection's in-flight places ("too many requests in flight"); the
// window's account readers (account_list, account_check) retry that refusal, as acp_agents does, so Providers does not
// show an empty list or "Couldn't check" for a busy moment.
import fs from 'node:fs';
import path from 'node:path';
import { expect, openWindow, test, codexFake } from './fixtures';
import { openRow } from './accounts-rows';
import { openSettings } from './settings-modal';

const BUSY = 'too many requests in flight; try again';
const ID = '0123456789abcdef0123456789abcdef';
// Signed in for "Your own" (its probe carries HOME) and for the added account alike.
const fake = (name: string, status: string, yes: string) => `#!/bin/sh
case "$1" in --version) echo "${name} 1.0.0"; exit 0;; esac
if [ "$1 $2" = "${status}" ]; then ${yes}; exit 0; fi
exec /bin/cat
`;

test('account_readers_retry_a_busy_core: the list and the own checks are refused once each, then shown', async ({ app, core }) => {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fake('claude', 'auth status', `echo '{"loggedIn": true}'`), { mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'bin/codex'), codexFake(fake('codex', 'login status', `echo 'Logged in using ChatGPT' >&2`)), { mode: 0o700 });
  fs.mkdirSync(path.join(core.home, 'accounts/claude', ID), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(core.home, 'accounts.toml'), `version = 1\n\n[[accounts]]\nagent = "claude"\nid = "${ID}"\nlabel = "Work"\n`);
  const refused: Record<string, number> = {};
  const state = { armed: false };
  await app.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      const msg = typeof m === 'string' ? JSON.parse(m) : null;
      const op = msg?.request?.op;
      const key = op === 'account_check' ? `${op}:${msg.request.agent}` : op;
      if (state.armed && (op === 'account_list' || op === 'account_check') && !refused[key]) {
        refused[key] = 1;
        return ws.send(JSON.stringify({ id: msg.id, response: { Err: BUSY } }));
      }
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  await openWindow(app);
  state.armed = true;
  await openSettings(app);
  await app.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Providers' }).click();
  await openRow(app, 'Claude');
  const claude = app.locator('#s-accounts .acct-card[data-agent-name="Claude"]');
  await expect(claude).toHaveCount(2);
  await expect(claude.filter({ hasText: 'Work' })).toContainText('Signed in');
  await expect(claude.first()).toContainText('Signed in'); // "Your own", checked as the page opens
  await expect(claude.first()).not.toContainText("Couldn't check");
  expect(refused).toMatchObject({ account_list: 1, 'account_check:claude': 1 }); // the busy replies were really served
});
