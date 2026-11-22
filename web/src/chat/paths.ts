// needs 171: the file paths a chat shows, read from the agent's own tool calls and from inline code. Pure: the
// caller turns a path into a session-relative one with `sessionPath` (pending.ts), which refuses `..` and anything
// outside the folder; the Files viewer (core) confines it again. Agent text is untrusted, so nothing here reads the disk.
import type { Data } from './feed';

type Use = Extract<Data, { kind: 'tool_use' }>;

const CLAUDE: Record<string, string> = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const CODEX = new Set(['apply_patch', 'read']);

/** The file a tool call works on: Claude `Read` / `Edit` / `Write` / `MultiEdit` (`file_path`), `NotebookEdit`
 *  (`notebook_path`); Codex `apply_patch` and `read` when the call carries a string `path` or `file_path`. */
export function toolPath(use: Use): string | null {
  const input = use.input;
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const key = Object.hasOwn(CLAUDE, use.name) ? o[CLAUDE[use.name]] : CODEX.has(use.name) ? o.path ?? o.file_path : null;
  return typeof key === 'string' && key ? key : null;
}

const SHAPE = /^[\w@+./-]+(:\d+)?$/;
/** Inline code that is a path: `src/a.ts`, `src/a.ts:12`, `README.md`. It has a `/` or ends in a 1-8 letter extension;
 *  a URL, a version (`v1.2`), a sentence or an empty string is not one. */
export function pathRef(text: string): { path: string; line?: number } | null {
  if (!SHAPE.test(text)) return null;
  const m = /^(.*?)(?::(\d+))?$/.exec(text)!;
  const [, path, line] = m;
  if (!path || !(path.includes('/') || /\.[A-Za-z]{1,8}$/.test(path))) return null;
  return line ? { path, line: Number(line) } : { path };
}
