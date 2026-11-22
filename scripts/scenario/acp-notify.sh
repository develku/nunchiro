#!/bin/sh
# V2-4a scenario acp_notification_and_focus: an ACP agent's permission request (the fake ACP agent of
# crates/nunchiro-core/tests/fixtures/acp, asking with no prompt in flight) raises the OS notification and the Waiting
# sound through the app's `notify` and `play_sound` commands, and a click on that notification focuses the session's
# tab. The window runs as inside the app with those commands recorded (the notification log); the core is a real
# `nunchiro serve` on a test home under .scratch (web/tests/fixtures.ts), never ~/.nunchiro, ~/.claude or ~/.codex.
# The spec is written to .scratch at run time and runs on Chromium with web/'s Playwright.
# Output: .scratch/receipts/acp-notify-<time>/notifications.json; exit 1 on any failure. Build first: cargo build -p nunchiro.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
[ -x target/debug/nunchiro ] || { echo "acp-notify: build first: cargo build -p nunchiro" >&2; exit 2; }
[ -d web/node_modules ] || { echo "acp-notify: web/node_modules missing; pnpm -C web install --offline --frozen-lockfile" >&2; exit 2; }
out="$root/.scratch/receipts/acp-notify-$(date +%Y%m%d-%H%M%S)"
spec="$root/.scratch/acp-notify-spec"
mkdir -p "$out" "$spec"
# ES modules like web/ (its fixtures use import.meta).
printf '{"type":"module"}\n' > "$spec/package.json"

cat > "$spec/playwright.config.ts" <<EOF
import base from '$root/web/playwright.config';
export default {
  ...base,
  testDir: '$spec',
  globalSetup: '$root/web/tests/global-setup.ts',
  outputDir: '$out/pw',
  workers: 1,
  webServer: { ...base.webServer, cwd: '$root/web' },
  projects: [base.projects![0]],
};
EOF

cat > "$spec/acp-notify.spec.ts" <<'EOF'
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, openWindow, test, REPO } from '../../web/tests/fixtures';

const LOG = process.env.ACP_NOTIFY_LOG!;

/** One owner request over the core socket (the test home's token, never the user's). */
function owner(home: string, request: object): Promise<{ Ok?: any; Err?: string }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path.join(home, 'core.sock'));
    let b = '';
    s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(home, 'core.token'), 'utf8').trim(), request }) + '\n'));
    s.on('data', (d) => {
      b += d;
      if (b.includes('\n')) {
        s.destroy();
        resolve(JSON.parse(b));
      }
    });
    s.on('error', reject);
  });
}

/** The page runs as inside the app; each `invoke` (notify, play_sound) is recorded. */
async function recordInvokes(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __calls: { cmd: string; args: any }[] };
    w.__calls = [];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => void w.__calls.push({ cmd, args }),
    };
  });
}
const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as unknown as { __calls: { cmd: string; args: any }[] }).__calls.filter((x) => x.cmd === c).map((x) => x.args), cmd);

test('acp_notification_and_focus', async ({ app, core }) => {
  await recordInvokes(app);
  const p = core.project('acpdemo');
  const fixture = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/acp/fake_agent.py');
  fs.writeFileSync(
    path.join(core.home, 'agents.toml'),
    `[[agent]]\nname = "fake"\ncommand = "/usr/bin/python3"\nargs = [${JSON.stringify(fixture)}, ${JSON.stringify(path.join(core.home, 'agent.log'))}]\nenv = []\n`,
  );
  const view = (await owner(core.home, { op: 'acp_agent_status', name: 'fake' })).Ok.view;
  expect((await owner(core.home, { op: 'acp_agent_grant', name: 'fake', hash: view.hash })).Ok.view.state).toBe('approved');
  const acp = core.cli('session', 'start', '--agent', 'acp:fake', '--project', p, '--label', 'acp-fake').session as { id: string };
  const other = core.shell(p, 'other');
  await openWindow(app);
  await app.locator(`.tab[data-tab="${other.id}"]`).click();
  await expect(app.locator(`.tab[data-tab="${acp.id}"]`)).toHaveAttribute('aria-selected', 'false');
  // The fake ends the turn, then asks permission with no prompt in flight.
  await expect.poll(async () => (await owner(core.home, { op: 'agent_prompt', id: acp.id, text: 'later' })).Ok?.type, { timeout: 10_000 }).toBe('delivery');
  await expect.poll(() => calls(app, 'notify'), { timeout: 5000 }).toHaveLength(1);
  const [note] = await calls(app, 'notify');
  expect(note.session).toBe(acp.id);
  expect(note.title).toBe('acp-fake · needs approval');
  await expect.poll(async () => (await calls(app, 'play_sound')).map((s) => s.name)).toContain('Ping');
  // The app shell turns a click on the notification into this event (app/src-tauri/src/main.rs `tap`).
  await app.evaluate((id) => window.dispatchEvent(new CustomEvent('nunchiro:notify.click', { detail: { session: id } })), acp.id);
  await expect(app.locator(`.tab[data-tab="${acp.id}"]`)).toHaveAttribute('aria-selected', 'true');
  fs.writeFileSync(LOG, JSON.stringify({ notify: await calls(app, 'notify'), play_sound: await calls(app, 'play_sound'), focused: acp.id }, null, 2));
});
EOF

# Another checkout's preview may hold 4173: a free port unless one is given (web/playwright.config.ts reads it).
NUNCHIRO_WEB_PORT=${NUNCHIRO_WEB_PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}
export NUNCHIRO_WEB_PORT
cd web
if ACP_NOTIFY_LOG="$out/notifications.json" pnpm exec playwright test --config "$spec/playwright.config.ts" >"$out/playwright.log" 2>&1; then
  echo "acp_notification_and_focus: PASS ($out/notifications.json)"
else
  tail -40 "$out/playwright.log" >&2
  echo "acp_notification_and_focus: FAIL ($out/playwright.log)" >&2
  exit 1
fi
