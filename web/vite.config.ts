import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// NUNCHIRO_WEB_PORT moves the loopback port when 4173 is taken (another checkout's preview).
const port = Number(process.env.NUNCHIRO_WEB_PORT ?? 4173);

/** V2.5-34l (ticket 181, 262): the short sha the About page shows, fixed at build time. NUNCHIRO_BUILD_SHA when it is a hex
 *  sha, else the git files of the checkout at `root` itself (read, no child process; a parent folder's .git, such as a
 *  dotfiles repo in $HOME, is never read), else "dev". A dirty tree is not detected. */
export function buildSha(root: string, env: Record<string, string | undefined>): string {
  const given = env.NUNCHIRO_BUILD_SHA?.trim().toLowerCase();
  if (given && /^[0-9a-f]{7,64}$/.test(given)) return given.slice(0, 7);
  try {
    return gitHead(root)?.slice(0, 7) ?? 'dev';
  } catch {
    return 'dev';
  }
}

function gitHead(root: string): string | null {
  const read = (f: string) => fs.readFileSync(f, 'utf8').trim();
  const sha = (s: string | undefined) => (s && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s) ? s : null);
  const dir = path.resolve(root);
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  // A worktree's `.git` is a file naming its own git folder; branch refs live in the common folder it names.
  let git = path.join(dir, '.git');
  if (fs.statSync(git).isFile()) git = path.resolve(dir, /^gitdir: (.+)$/m.exec(read(git))?.[1] ?? '');
  const common = fs.existsSync(path.join(git, 'commondir')) ? path.resolve(git, read(path.join(git, 'commondir'))) : git;
  const head = read(path.join(git, 'HEAD'));
  const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
  if (!ref) return sha(head);
  for (const d of [git, common]) if (fs.existsSync(path.join(d, ref))) return sha(read(path.join(d, ref)));
  const packed = path.join(common, 'packed-refs');
  if (!fs.existsSync(packed)) return null;
  return sha(read(packed).split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0]);
}

export default defineConfig({
  plugins: [react()],
  define: { __NUNCHIRO_BUILD__: JSON.stringify(buildSha(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.env)) },
  // Tauri serves the built files; the dev server is loopback only.
  server: { host: '127.0.0.1', port, strictPort: true },
  preview: { host: '127.0.0.1', port, strictPort: true },
  // NUNCHIRO_COVERAGE=1 (scripts/affected-specs.py gen): the instrumented run maps bundle ranges back to sources.
  // Fonts are never inlined as data: URLs: the window CSP has no font-src, so default-src 'self' would block them
  // (KaTeX_Size3 is under the 4 KiB inline limit).
  build: {
    outDir: 'dist',
    target: 'safari16',
    sourcemap: !!process.env.NUNCHIRO_COVERAGE,
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
