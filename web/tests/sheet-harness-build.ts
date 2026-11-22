// The permission sheet has no home in the app until the gallery lands (ticket 19): a harness page is bundled into dist/__sheet,
// which the preview server (the origin the core's allowlist accepts) already serves. Shared by permission-sheet.spec.ts and
// raw-words.spec.ts (ticket 564).
import fs from 'node:fs';
import path from 'node:path';
import type { Rollup } from 'vite';
import { buildQuiet } from './vite-build';
import { REPO, type Core } from './fixtures';

const FIXTURE = path.join(REPO, 'crates/nunchiro-core/tests/fixtures/approval/open-prs');
export const BASE = '/__sheet/';

export async function buildSheetHarness() {
  const out = await buildQuiet({
    configFile: path.join(REPO, 'web/vite.config.ts'),
    root: path.join(REPO, 'web'),
    base: BASE,
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: path.join(REPO, 'web/tests/sheet-harness.html') } },
  });
  const results = Array.isArray(out) ? out : [out as Rollup.RollupOutput];
  for (const o of results.flatMap((r) => ('output' in r ? r.output : []))) {
    const dest = path.join(REPO, 'web/dist', BASE, o.fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Workers write the same bytes; rename keeps a reader from seeing half a file.
    fs.writeFileSync(`${dest}.${process.pid}`, o.type === 'chunk' ? o.code : o.source);
    fs.renameSync(`${dest}.${process.pid}`, dest);
  }
}

export function widget(core: Core, name: string, edit?: (manifest: string) => string) {
  const dir = path.join(core.home, 'widgets', name);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (edit) fs.writeFileSync(path.join(dir, 'widget.toml'), edit(fs.readFileSync(path.join(dir, 'widget.toml'), 'utf8')));
  return dir;
}
