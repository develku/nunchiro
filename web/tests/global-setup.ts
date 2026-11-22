import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The fixtures drive the real core binary; build it in this checkout's own target/.
export default function setup() {
  const env = { ...process.env };
  delete env.CARGO_TARGET_DIR;
  execFileSync('cargo', ['build', '-q', '-p', 'nunchiro'], { cwd: path.resolve(import.meta.dirname, '../..'), env, stdio: 'inherit' });
}
