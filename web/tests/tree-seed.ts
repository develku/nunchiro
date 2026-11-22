// V2-9a: owner-socket tree edits a spec makes before the window opens (a second window sees an edit at its next load).
// The owner socket answers one request per connection, so each edit connects afresh.
import { execFileSync } from 'node:child_process';
import type { Core } from './fixtures';

const OWNER = `const net = require('net'), fs = require('fs'), path = require('path'); const [h, edits] = [process.argv[1], JSON.parse(process.argv[2])];
const token = fs.readFileSync(path.join(h, 'core.token'), 'utf8').trim();
const one = (edit) => new Promise((ok, no) => { const s = net.connect(path.join(h, 'core.sock')); let b = '';
  s.on('connect', () => s.write(JSON.stringify({ token, request: { op: 'tree_edit', edit } }) + '\\n'));
  s.on('data', (d) => { b += d; if (b.includes('\\n')) { s.destroy(); const r = JSON.parse(b); r.Ok ? ok() : no(new Error(JSON.stringify(r))); } }); s.on('error', no); });
(async () => { for (const e of edits) await one(e); })().catch((e) => (console.error(String(e)), process.exit(1)));`;
export const seed = (core: Core, ...edits: object[]) => execFileSync(process.execPath, ['-e', OWNER, core.home, JSON.stringify(edits)], { timeout: 10_000 });

// ponytail: the Other projects line is gone (ticket 370, item 361), so this only writes stale `quiet:` keys the tree ignores; delete it with its callers in specs other lanes own.
export const openQuiet = (core: Core, ...lines: string[]) => seed(core, ...['', ...lines].map((n) => ({ op: 'fold', key: `quiet:${n}`, folded: true })));
