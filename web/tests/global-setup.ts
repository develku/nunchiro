import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** Where the fixtures run the core (`target/debug/nunchiro` of this checkout), and where cargo puts it. */
export function binPaths(env: NodeJS.ProcessEnv, repo = REPO) {
  const dir = env.CARGO_TARGET_DIR ? path.resolve(repo, env.CARGO_TARGET_DIR) : path.join(repo, 'target');
  return { built: path.join(dir, 'debug/nunchiro'), used: path.join(repo, 'target/debug/nunchiro') };
}

// The fixtures drive the real core binary. It builds where CARGO_TARGET_DIR says (a build folder off the internal disk),
// and only the one binary is linked at target/debug/nunchiro: a symlinked target/ folder breaks the start_secrets tests.
export default function setup() {
  execFileSync('cargo', ['build', '-q', '-p', 'nunchiro'], { cwd: REPO, stdio: 'inherit' });
  const { built, used } = binPaths(process.env);
  if (fs.existsSync(used) && fs.realpathSync(used) === fs.realpathSync(built)) return;
  fs.mkdirSync(path.dirname(used), { recursive: true });
  fs.rmSync(used, { force: true });
  fs.symlinkSync(built, used);
  if (fs.realpathSync(used) !== fs.realpathSync(built)) throw new Error(`${used} does not reach ${built}`);
}
