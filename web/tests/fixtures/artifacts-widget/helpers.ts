// Fixture sessions for the Artifacts widget tests (ticket v1b-13): a git project for Diff, 05's saved image paths
// and 06's agent Write records.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rec, type ChatCore } from '../chat/harness';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const page1 = (title: string, body = '<p>hello</p>') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'gc.auto=0', ...args], { encoding: 'utf8' });

export function write(dir: string, rel: string, body: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
}

/**
 * A chat session started in a git project with one commit (`files`), so Diff has a start commit; `null`: no git;
 * `'no_commits'`: a repository without commits.
 */
export function gitChat(core: ChatCore, label: string, files: Record<string, string> | null | 'no_commits' = {}) {
  const dir = core.project(label);
  if (files) git(dir, 'init', '-q');
  if (files && files !== 'no_commits') {
    for (const [p, body] of Object.entries(files)) write(dir, p, body);
    write(dir, '.keep', '');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return core.chat(label);
}

/** 05's saved form: `<home>/images/<session>/<sha256>.png`; returns the absolute path the prompt carries. */
export function savedImage(core: ChatCore, session: string, bytes: Buffer) {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(core.home, 'images', session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${sha}.png`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

/** Writes the file into the session folder and the agent's Write call and result for it (06's harness shape). */
export function written(s: { cwd: string }, id: string, rel: string, content: string | Buffer, opts: { at?: string; record?: string } = {}) {
  const full = opts.at ?? path.join(s.cwd, rel);
  if (!opts.at) write(s.cwd, rel, content);
  const text = opts.record ?? (typeof content === 'string' ? content : '');
  return [
    rec.use(id, 'Write', { file_path: full, content: text }),
    rec.result(id, `File created successfully at: ${full}`, { toolUseResult: { type: 'create', filePath: full, content: text, structuredPatch: [] } }),
  ];
}
