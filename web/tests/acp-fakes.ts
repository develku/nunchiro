// V2-4b specs: fake ACP agents on the core's PATH, and the owner socket for what the window does not show. The fake
// agent is V2-4a's (crates/nunchiro-core/tests/fixtures/acp/fake_agent.py); its modes come from the wrapper, never env.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, type Core } from './fixtures';

export const AGENT_PY = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/acp/fake_agent.py');

/** `<home>/bin/<name>`: answers `--version`; otherwise waits `delay` s and is the fake ACP agent with `modes`. */
export function fakeAcp(core: Core, name: string, version: string, modes: string[] = [], delay = 0) {
  const script = `#!/bin/sh\n[ "$1" = --version ] && { echo '${version}'; exit 0; }\n${delay ? `sleep ${delay}\n` : ''}exec /usr/bin/python3 ${AGENT_PY} ${path.join(core.home, `${name}.log`)} ${modes.join(' ')}\n`;
  fs.writeFileSync(path.join(core.home, 'bin', name), script, { mode: 0o700 });
  return path.join(core.home, 'bin', name);
}
/** A terminal-only CLI (no ACP): answers `--version`, else idles like `cat`. */
export function fakeTerminalCli(core: Core, name: string, version: string) {
  fs.writeFileSync(path.join(core.home, 'bin', name), `#!/bin/sh\n[ "$1" = --version ] && { echo '${version}'; exit 0; }\nprintf '${name} ready\\r\\n'\nexec /bin/cat\n`, { mode: 0o700 });
  return path.join(core.home, 'bin', name);
}

const OWNER = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, req] = process.argv.slice(1);
const s = net.connect(path.join(h, 'core.sock')); let b = '';
s.on('connect', () => s.write(JSON.stringify({ token: fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim(), request: JSON.parse(req) }) + '\\n'));
s.on('data', (d) => { b += d; if (b.includes('\\n')) { process.stdout.write(b); s.destroy(); } });`;
/** One request on the owner socket, answered as the wire shows it (`{Ok}` or `{Err}`). */
export function owner(core: Core, request: Record<string, unknown>) {
  return JSON.parse(execFileSync(process.execPath, ['-e', OWNER, core.home, JSON.stringify(request)], { encoding: 'utf8', timeout: 30_000 })) as { Ok?: Record<string, any>; Err?: string };
}
export const ownerOk = (core: Core, request: Record<string, unknown>) => {
  const r = owner(core, request);
  if (!r.Ok) throw new Error(`${JSON.stringify(request)} -> ${r.Err}`);
  return r.Ok;
};

/** The core's approval hash of an entry (approval/hash.rs `entry`), computed here from the text the sheet showed. */
export function entryHash(e: { name: string; command: string; args: string[]; env: string[] }) {
  const h = createHash('sha256');
  h.update('nunchiro-agent-v1\0');
  const field = (s: string) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(b.length));
    h.update(len);
    h.update(b);
  };
  field(e.name);
  field(e.command);
  for (const list of [e.args, e.env]) {
    field(String(list.length));
    list.forEach(field);
  }
  return h.digest('hex');
}

export const agentsToml = (core: Core) => path.join(core.home, 'agents.toml');
/** An `[[agent]]` table for a fake ACP wrapper. */
export const tomlEntry = (name: string, command: string, args: string[] = [], env: string[] = []) =>
  `[[agent]]\nname = "${name}"\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenv = ${JSON.stringify(env)}\n`;
