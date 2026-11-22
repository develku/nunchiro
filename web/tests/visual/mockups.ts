// The approved mockups the visual gate crops, copied into the repo (mockups/README.md names each one's decision).
import fs from 'node:fs';
import path from 'node:path';

export const MOCKUPS = path.join(import.meta.dirname, 'mockups');

/** A mockup's path; a missing file is an error, never a skipped or expected-failing check. */
export function mockup(file: string) {
  const p = path.join(MOCKUPS, file);
  if (!fs.existsSync(p)) throw new Error(`visual gate: mockup ${file} is missing from ${MOCKUPS}`);
  return p;
}
