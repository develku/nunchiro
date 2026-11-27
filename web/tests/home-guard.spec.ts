// V1A-50: no fixture CLI call reaches the owner's ~/.nunchiro. A stray call there auto-starts a core that the owner's
// app then connects to (a v1a-46 run held ~/.nunchiro/core.sock for 3 h). This spec never touches the real home: it
// reads the process list and the test's own sentinel HOME only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, nunchiro, REPO, test } from './fixtures';

const BIN = path.join(REPO, 'target/debug/nunchiro');
const SCRATCH = path.join(REPO, '.scratch') + path.sep;

/** NUNCHIRO_HOME of every `serve` this checkout's binary runs (macOS `ps -E` shows the environment of own processes).
 *  Ticket 419: every process's full environment passes 1 MiB (the default buffer) on a busy machine; 64 MiB is room for it. */
const serveHomes = () =>
  execFileSync('/bin/ps', ['-E', '-ww', '-x', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter((l) => l.startsWith(`${BIN} serve`))
    .map((l) => / NUNCHIRO_HOME=(\S+)/.exec(l)?.[1] ?? '(none: $HOME/.nunchiro)');

test('fixture CLI calls run on the test home only; one that loses it is refused, and HOME is a sentinel', async ({ core }) => {
  const sentinel = core.env.HOME!;
  expect(sentinel.startsWith(core.home)).toBe(true);
  const s = core.shell(core.project('demo'), 'a');
  core.cli('snapshot', '--json');
  core.read(s.id);
  core.screen(s.id);
  // Every helper above went to the test's core: nothing fell back to $HOME/.nunchiro.
  expect(fs.readdirSync(sentinel)).toEqual([]);
  expect(serveHomes()).toContain(core.home); // the check sees this checkout's cores
  for (const home of serveHomes()) expect(home.startsWith(SCRATCH), `serve from this checkout on ${home}`).toBe(true);
  // A call whose env lost the test home fails loudly instead of reaching any home.
  const kept = core.env.NUNCHIRO_HOME;
  delete core.env.NUNCHIRO_HOME;
  try {
    expect(() => core.cli('snapshot', '--json')).toThrow(/must be this test's folder under \.scratch/);
  } finally {
    core.env.NUNCHIRO_HOME = kept;
  }
  expect(fs.readdirSync(sentinel)).toEqual([]);
});

// V1A-52: a spec's own exec of the CLI skips the guard above; every child_process call in web/tests must start an
// allowed tool, and the nunchiro binary goes through fixtures.ts `nunchiro()` / `Core.run`. Starting a core
// (`spawn(<bin>, ['serve'], { env: this.env | core.env })`, the test's own isolated env) is not a CLI call.
// V1A-54: namespaced calls count (`cp.execFileSync(...)`; `x.exec(` only on a child_process import, as `re.exec` is a
// regex), and fixtures.ts is scanned except for the guarded runner itself.
// shortcut: a textual scan, so an aliased import (`execFileSync as x`) passes; widen it if one ever appears.
const ALLOWED = new Set(["'git'", "'python3'", "'cargo'", "'/bin/ps'", 'process.execPath']);
const TEST_ENV = /^\{\s*env:\s*(?:this|core)\.env\b/;
// V2.5-41: `sh` may run a repo script named by path (`[path.join(REPO, 'scripts/<name>.sh'), ...]`): a script under
// scripts/, not the binary. No `..`, no subfolder, no `-c`; any other sh argument list is still a finding.
// shortcut: `REPO` is matched as text (a spec that redefines it passes) and the script's own arguments are not
// checked; resolve the path from the source if a spec ever shadows REPO.
const SH = new Set(["'sh'", "'/bin/sh'"]);
const REPO_SCRIPT = /^\[\s*path\.join\(REPO,\s*'scripts\/[\w-]+\.sh'\)\s*(?:,|\])/;
const directCalls = (src: string) => {
  const ns = new Set([...src.matchAll(/(?:import\s+(?:\*\s+as\s+)?(\w+)\s+from|(?:const|let|var)\s+(\w+)\s*=\s*require\()\s*['"](?:node:)?child_process['"]/g)].map((m) => m[1] ?? m[2]));
  return [...src.matchAll(/(?<![.\w$])(?:([\w$]+)\.)?(execFileSync|execFile|execSync|exec|spawnSync|spawn)\(\s*((?:[^,()]|\([^)]*\))+)\s*(?:,\s*(\[[^\]]*\]))?(?:\s*,\s*(\{[^}]*))?/g)]
    .filter((m) => !(m[1] && m[2] === 'exec' && !ns.has(m[1])))
    .filter((m) => !ALLOWED.has(m[3].trim()) && !(m[2] === 'spawn' && m[4] === "['serve']" && TEST_ENV.test(m[5] ?? '')))
    .filter((m) => !(SH.has(m[3].trim()) && REPO_SCRIPT.test(m[4] ?? '')))
    .map((m) => m[3].trim());
};
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
/** fixtures.ts without the guarded runner, the one place allowed to exec the binary. */
const withoutRunner = (src: string) => {
  const at = src.indexOf('export function nunchiro(');
  const end = src.indexOf('\n}\n', at);
  if (at < 0 || end < 0) throw new Error('fixtures.ts: the guarded runner nunchiro() was not found');
  return src.slice(0, at) + src.slice(end + 3);
};

test('spec-home-guard: no spec runs the nunchiro binary except through the guarded fixture runner', () => {
  // The scan bites: the call shapes V1A-50 left behind are found.
  expect(directCalls("execFileSync(BIN, ['widget', 'allow'], { env: core.env })")).toEqual(['BIN']);
  expect(directCalls("execFileSync(path.join(REPO, 'target/debug/nunchiro'), ['serve', 'stop'])")).toEqual(["path.join(REPO, 'target/debug/nunchiro')"]);
  expect(directCalls("execFileSync(L.bin, a, { env })")).toEqual(['L.bin']);
  expect(directCalls("spawn(BIN, ['widget', 'allow'], { env })")).toEqual(['BIN']);
  expect(directCalls("exec(`${BIN} snapshot`)")).toEqual(['`${BIN} snapshot`']);
  expect(directCalls("execFileSync('git', ['-C', dir])")).toEqual([]);
  expect(directCalls("spawn(BIN, ['serve'], { env: this.env })")).toEqual([]);
  expect(directCalls("spawn(path.join(REPO, 'target/debug/nunchiro'), ['serve'], { env: core.env, stdio: 'ignore' })")).toEqual([]);
  expect(directCalls('/x/.exec(line)')).toEqual([]);
  expect(directCalls('const m = re.exec(line)')).toEqual([]);
  // V1A-54: a namespaced call, a serve without the test's env, and a namespaced exec on a child_process import.
  expect(directCalls("cp.execFileSync(BIN, ['snapshot'], { env: core.env })")).toEqual(['BIN']);
  expect(directCalls("child.spawn(BIN, ['snapshot'])")).toEqual(['BIN']);
  expect(directCalls("spawn(BIN, ['serve'])")).toEqual(['BIN']);
  expect(directCalls("spawn(BIN, ['serve'], { env: process.env })")).toEqual(['BIN']);
  expect(directCalls("spawn(BIN, ['serve'], { stdio: 'ignore', env: this.env })")).toEqual(['BIN']);
  expect(directCalls("import * as cp from 'node:child_process';\ncp.exec(`${BIN} snapshot`)")).toEqual(['`${BIN} snapshot`']);
  expect(directCalls("const cp = require('child_process'); cp.exec(BIN)")).toEqual(['BIN']);
  // fixtures.ts outside its runner: an exec added there is found.
  const fixtures = fs.readFileSync(path.join(import.meta.dirname, 'fixtures.ts'), 'utf8');
  expect(directCalls(withoutRunner(fixtures) + "\nexecFileSync(BIN, ['snapshot']);")).toEqual(['BIN']);
  const found = sources(import.meta.dirname)
    .filter((f) => path.basename(f) !== 'home-guard.spec.ts') // this file's samples
    .flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return directCalls(path.basename(f) === 'fixtures.ts' ? withoutRunner(src) : src).map((a) => `${path.relative(import.meta.dirname, f)}: ${a}`);
    });
  expect(found).toEqual([]);
});

test('spec-home-guard: sh may run a repo script by path, never another path or the nunchiro binary', () => {
  expect(directCalls("spawnSync('sh', [path.join(REPO, 'scripts/dead-click-check.sh'), BASELINE, FOUND], { encoding: 'utf8' })")).toEqual([]);
  expect(directCalls("execFileSync('/bin/sh', [path.join(REPO, 'scripts/x-y.sh')])")).toEqual([]);
  // Refused: a path outside scripts/, a `..` out of it, a non-.sh file, the binary, `-c`, and a script not named by path.
  for (const [cmd, args] of [
    ["'sh'", "['/tmp/x.sh']"],
    ["'sh'", "[path.join(REPO, 'scripts/../target/debug/nunchiro')]"],
    ["'sh'", "[path.join(REPO, 'scripts/x.py')]"],
    ["'sh'", "[path.join(REPO, 'target/debug/nunchiro'), 'snapshot']"],
    ["'sh'", "[BIN, 'snapshot']"],
    ["'sh'", "['-c', `${BIN} snapshot`]"],
    ["'sh'", "[path.join(REPO, 'scripts/a.sh', BIN)]"],
    ["'/bin/sh'", "[script]"],
  ])
    expect(directCalls(`spawnSync(${cmd}, ${args})`), args).toEqual([cmd]);
});

test('spec-home-guard: the guarded runner resolves a `..` path before checking it is under .scratch', () => {
  const home = `${SCRATCH}../outside-scratch`; // a raw string: path.join would already drop the `..`
  // --version reads no home, so even an unguarded run starts no core outside .scratch.
  expect(() => nunchiro({ NUNCHIRO_HOME: home, HOME: home, PATH: '/usr/bin:/bin' }, ['--version'])).toThrow(/must be this test's folder under \.scratch/);
  const inside = `${SCRATCH}pw-x/../../.scratch/pw-x`;
  expect(path.resolve(inside).startsWith(SCRATCH)).toBe(true); // a `..` that stays inside is fine
});

test('spec-home-guard: a real-agent scenario home (lib.SCENARIO_HOMES, outside any repo) is allowed; a `..` out of it is not', () => {
  const homes = path.join(os.userInfo().homedir, 'Library/Caches/nunchiro-scenario-homes') + path.sep;
  const env = (h: string) => ({ NUNCHIRO_HOME: h, HOME: `${h}/sentinel-home`, PATH: '/usr/bin:/bin' });
  expect(nunchiro(env(`${homes}cabc`), ['--version'])).toMatch(/nunchiro/i);
  expect(() => nunchiro(env(`${homes}../escaped`), ['--version'])).toThrow(/must be this test's folder under \.scratch/);
});
