// V2.5-26 shared fixture for design-shell*.spec.ts: a window with working agents (kept out of a spec file, whose
// module-level skips would follow an import).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Core, expect, REPO } from './fixtures';

// The agent hook over the owner socket (chat-stop.spec.ts): "UserPromptSubmit" marks a session working.
const HOOK = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, id, event] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: { op: 'hook', id, event, payload: {} } }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
const hook = (core: Core, id: string) => execFileSync(process.execPath, ['-e', HOOK, core.home, id, 'UserPromptSubmit'], { encoding: 'utf8', timeout: 10_000 });

/** lumen: two working agents, one waiting, one idle shell; demo: one shell. */
export function shellFixture(core: Core) {
  fs.writeFileSync(path.join(core.home, 'bin/claude'), fs.readFileSync(path.join(REPO, 'crates/nunchiro-core/tests/fixtures/claude-mode')), { mode: 0o700 });
  const p = core.project('lumen');
  const a = core.agent(p, 'refactor-auth', 'never');
  const b = core.agent(p, 'fix-tests', 'never');
  const w = core.agent(p, 'asks', 'go');
  core.shell(p, 'notes');
  core.shell(core.project('demo'), 'demo-shell');
  fs.writeFileSync(path.join(w.cwd, 'go'), '');
  return { a, b, w };
}

export async function working(core: Core, ...ids: string[]) {
  for (const id of ids) hook(core, id);
  await expect.poll(() => (core.cli('snapshot', '--json').sessions as { id: string; attention: { working: boolean } }[]).filter((s) => ids.includes(s.id) && s.attention.working).length, { timeout: 15_000 }).toBe(ids.length);
}

