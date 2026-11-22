// Chat rows from chat events (view logic; ticket 02 emits tool events ungrouped). Pure, so it is rebuilt from
// the loaded events on every page and a row's key (its first event's cursor) stays stable across live pushes.
import { basename as base } from '../tree';
import type { T } from '../i18n';
import type { ChatEvent, Data } from './feed';
import { pendingEdit, tighten } from './pending'; // v1b-12
import type { View } from './view';

type Of<K extends Data['kind']> = Extract<Data, { kind: K }>;
export type Image = Of<'image'>;

export interface Tool {
  key: number;
  use: Of<'tool_use'>;
  result?: Of<'tool_result'>;
  task?: Of<'task_result'>;
}

export type Row =
  | { kind: 'user'; key: number; text: string; images: Image[] }
  | { kind: 'assistant'; key: number; text: string }
  | { kind: 'final'; key: number; text: string }
  | { kind: 'thinking'; key: number; text: string }
  | { kind: 'tool'; key: number; tool: Tool }
  | { kind: 'group'; key: number; tools: Tool[] }
  | { kind: 'task'; key: number; tool: Tool }
  // Q9 fr-J19-1: `more` marks the 2nd+ file of one call; that call's buttons and step show on its first card only.
  | { kind: 'diff'; key: number; edit: Of<'edit'>; tool?: Tool; more?: true }
  | { kind: 'image'; key: number; role: string; images: Image[] }
  | { kind: 'orphan'; key: number; output: unknown; is_error: boolean }
  | { kind: 'interrupted'; key: number }
  | { kind: 'turnfiles'; key: number; files: string[] } // ticket 222: a finished turn's written files (core turn_files.rs)
  | { kind: 'artifact'; key: number; data: Of<'artifact'> } // v1b-06
  // CHROME: the Normal and Thinking views fold a turn's tool calls into `summary` and its finished edits into `changes`.
  | { kind: 'summary'; key: number; rows: Row[]; parts: SummaryPart[]; tests: string | null; seconds: number | null }
  | { kind: 'changes'; key: number; files: { path: string; added: number; removed: number }[]; added: number; removed: number; turn?: string[] };

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const SEARCHES = new Set(['Grep', 'Glob']);
const TASKS = new Set(['Task', 'Agent', 'spawn_agent']);
// find and fd are left out: -delete and -exec make them writes.
const READ_CMD = /^\s*(cat|nl|head|tail|sed\s+-n|less|wc|ls|rg|grep)\b/;
const SEARCH_CMD = /^\s*(rg|grep)\b/;

/** The command line of a shell tool call (Claude Bash `command`, Codex `cmd` string or argv array). */
export function command(input: unknown): string | null {
  // Look 11-17 N9: Codex 0.161's `exec` is a script; one that makes a single `tools.exec_command` call reads as that command.
  if (typeof input === 'string') {
    const literal = /\bcmd"?\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input)?.[1];
    if (!literal || input.match(/\btools\./g)?.length !== 1 || !input.includes('tools.exec_command(')) return null;
    try {
      return JSON.parse(literal) as string;
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const c = o.command ?? o.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    // Codex wraps commands as ["bash", "-lc", "<script>"].
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(c[0]) && c[1].startsWith('-')) return c[2];
    return c.join(' ');
  }
  return null;
}

export function isSearch(t: Tool): boolean {
  if (SEARCHES.has(t.use.name)) return true;
  const c = command(t.use.input);
  return c !== null && SEARCH_CMD.test(c);
}

/** Reads and searches group into one row; a write, an edit or a failed call never does. */
function groupable(t: Tool, edits: Set<string>): boolean {
  if (edits.has(t.use.tool_id) || t.result?.is_error) return false;
  if (READS.has(t.use.name)) return true;
  const c = command(t.use.input);
  // A pipeline or redirect may write; only a plain read command joins the group.
  return c !== null && READ_CMD.test(c) && !/[>|;&]/.test(c);
}

/** Home N-E (look 1117 v4f): Claude's Write of a new file reports an empty patch, so its card read "+0 -0" while git (the
 *  header) counted the lines. An empty edit of a Write counts the written content's lines, as git does. */
function written(e: Of<'edit'>, tool: Tool | undefined): Of<'edit'> {
  const content = (tool?.use.input as { content?: unknown } | undefined)?.content;
  if (tool?.use.name !== 'Write' || typeof content !== 'string' || e.hunks.length || e.added || e.removed) return e;
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { ...e, added: lines.length, removed: e.removed === null ? null : 0, hunks: lines.map((l) => `+${l}`) };
}

export function buildRows(events: ChatEvent[]): Row[] {
  const tools = new Map<string, Tool>();
  const edits = new Map<string, Of<'edit'>[]>();
  for (const e of events) {
    const d = e.data;
    if (d.kind === 'tool_use') tools.set(d.tool_id, { key: e.cursor, use: d });
  }
  for (const e of events) {
    const d = e.data;
    if (d.kind === 'tool_result' && tools.has(d.tool_id)) tools.get(d.tool_id)!.result = d;
    if (d.kind === 'task_result' && tools.has(d.tool_id)) tools.get(d.tool_id)!.task = d;
    if (d.kind === 'edit') edits.set(d.tool_id, [...(edits.get(d.tool_id) ?? []), tighten(written(d, tools.get(d.tool_id)))]); // B9: true counts and context lines
  }
  const edited = new Set(edits.keys());
  const rows: Row[] = [];
  const last = () => rows[rows.length - 1];
  for (const e of events) {
    const d = e.data;
    const key = e.cursor;
    switch (d.kind) {
      case 'message':
        if (!d.text.trim()) break;
        rows.push(d.role === 'user' ? { kind: 'user', key, text: d.text, images: [] } : { kind: 'assistant', key, text: d.text });
        break;
      case 'final_text':
        rows.push({ kind: 'final', key, text: d.text });
        break;
      case 'image': {
        const prev = last();
        // An image block follows its message's text block: it belongs to the same user turn.
        if (prev && (prev.kind === 'user' || prev.kind === 'image') && d.role === 'user') prev.images.push(d);
        else rows.push({ kind: 'image', key, role: d.role, images: [d] });
        break;
      }
      case 'thinking':
        if (d.text.trim()) rows.push({ kind: 'thinking', key, text: d.text });
        break;
      case 'tool_use': {
        const tool = tools.get(d.tool_id)!;
        // A later tool_use with the same id replaces nothing: the first one owns the row.
        if (tool.key !== key) break;
        const edit = edits.get(d.tool_id);
        if (edit) {
          // A patch of several files (Codex apply_patch, an ACP call with several diffs) is one card per file.
          edit.forEach((one, i) => rows.push({ kind: 'diff', key: key + i / 1000, edit: one, tool, ...(i ? { more: true as const } : {}) }));
          break;
        }
        // v1b-12: an edit call still waiting for its result (and maybe for a permission) shows as its card.
        const proposed = tool.result ? null : pendingEdit(d);
        if (proposed) {
          rows.push({ kind: 'diff', key, edit: proposed, tool });
          break;
        }
        if (TASKS.has(d.name)) {
          rows.push({ kind: 'task', key, tool });
          break;
        }
        const prev = last();
        if (groupable(tool, edited)) {
          if (prev?.kind === 'group') {
            prev.tools.push(tool);
            break;
          }
          if (prev?.kind === 'tool' && groupable(prev.tool, edited)) {
            rows[rows.length - 1] = { kind: 'group', key: prev.key, tools: [prev.tool, tool] };
            break;
          }
        }
        rows.push({ kind: 'tool', key, tool });
        break;
      }
      case 'tool_result':
        // Results join their call's row; one whose call is on an older, unloaded page shows on its own.
        if (!tools.has(d.tool_id)) rows.push({ kind: 'orphan', key, output: d.output, is_error: d.is_error });
        break;
      case 'edit':
        if (!tools.has(d.tool_id)) rows.push({ kind: 'diff', key, edit: tighten(d) });
        break;
      case 'turn': {
        if (d.state === 'interrupted') rows.push({ kind: 'interrupted', key });
        // Ticket 222: a turn that wrote files gets its "N changed files" row, after the interrupted note if any.
        const files = (d as { files?: unknown }).files;
        if (Array.isArray(files) && files.length) rows.push({ kind: 'turnfiles', key: key + 0.25, files: files.filter((f): f is string => typeof f === 'string') });
        break;
      }
      case 'artifact': // v1b-06
        rows.push({ kind: 'artifact', key, data: d });
        break;
      // task_result joins its Task row; skipped and version_banner are shown outside the list.
    }
  }
  return rows;
}

/** Merges one page into the loaded events, by cursor, without duplicates. */
export function mergeEvents(have: ChatEvent[], add: ChatEvent[]): ChatEvent[] {
  if (!add.length) return have;
  const lastHave = have.length ? have[have.length - 1].cursor : -Infinity;
  if (add[0].cursor > lastHave) return [...have, ...add];
  const firstHave = have.length ? have[0].cursor : Infinity;
  if (add[add.length - 1].cursor < firstHave) return [...add, ...have];
  const byCursor = new Map(have.map((e) => [e.cursor, e]));
  for (const e of add) byCursor.set(e.cursor, e);
  return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
}

// ANSI escape sequences in tool output are terminal styling, not text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
export const plain = (s: string) => s.replace(ANSI, '');

/** Tool output as text: a string, or Claude content blocks (text kept, images named). */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return plain(output);
  if (Array.isArray(output))
    return output
      .map((b) => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? plain(b.text) : b && typeof b === 'object' && (b as { type?: string }).type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  if (output === null || output === undefined) return '';
  return plain(JSON.stringify(output, null, 2));
}

/** One Codex exec receipt ({chunk_id, wall_time_seconds, exit_code, output, …}) as the command's output and, when it
 *  failed, its exit code; null for any other text. A receipt with no output is still a receipt, never shown raw. */
function receiptOutput(text: string): string | null {
  try {
    const r = JSON.parse(text) as { output?: unknown; exit_code?: unknown; metadata?: { exit_code?: unknown } };
    if (!r || typeof r !== 'object' || !(typeof r.output === 'string' ? 'exit_code' in r || 'metadata' in r : 'chunk_id' in r && 'exit_code' in r)) return null;
    const code = r.exit_code ?? r.metadata?.exit_code;
    return [typeof r.output === 'string' ? plain(r.output).trimEnd() : '', typeof code === 'number' && code !== 0 ? `exit code ${code}` : ''].filter(Boolean).join('\n');
  } catch {
    return null;
  }
}
const SCRIPT_HEAD = /^Script completed\nWall time [^\n]*\nOutput:\n/;

/** Look 1117 v5 (B S3): what a tool's result shows. Codex's exec result is a JSON receipt; the row shows its output, and a
 *  failing exit code when there is one. Sixth look (B6-S3-1): Codex 0.161 runs a command through its exec script, whose
 *  result is the script's own three lines and then that receipt as one line: the same output, without the script's
 *  frame. Any other result as is. */
export function shownOutput(output: unknown): string {
  const text = outputText(output);
  const whole = receiptOutput(text);
  if (whole !== null) return whole;
  let found = false;
  const lines = text.split('\n').map((l) => {
    const r = l.startsWith('{') ? receiptOutput(l) : null;
    if (r !== null) found = true;
    return r ?? l;
  });
  return found ? lines.join('\n').replace(SCRIPT_HEAD, '').replace(/^\n+/, '').trimEnd() : text;
}

export function inputText(input: unknown): string {
  return typeof input === 'string' ? plain(input) : plain(JSON.stringify(input, null, 2));
}

/** The one-line label of a tool call: verb, then the dim detail. */
export function toolLine(t: Tool): [string, string] {
  const i = (t.use.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const out = t.result ? shownOutput(t.result.output).trim().split('\n').filter(Boolean).pop() ?? '' : '';
  const c = command(t.use.input);
  if (c !== null) return [`Ran ${c.split('\n')[0]}`, t.result?.is_error ? `failed · ${out}` : out];
  const target = str(i.file_path) || str(i.path) || str(i.pattern) || str(i.url) || str(i.query) || str(i.description);
  return [`${t.use.name}${target ? ` ${t.use.name === 'Read' ? base(target) : target}` : ''}`, t.result?.is_error ? `failed · ${out}` : ''];
}

/** A Task row's label: its description, else the first line of its prompt. */
export function taskLine(t: Tool): string {
  const i = (t.use.input ?? {}) as Record<string, unknown>;
  const what = typeof i.description === 'string' ? i.description : typeof i.prompt === 'string' ? i.prompt.split('\n')[0] : '';
  return `Task${what ? ` ${what}` : ''}`;
}

export function groupLine(tools: Tool[]): [string, string] {
  const searches = tools.filter(isSearch).length;
  const reads = tools.length - searches;
  const parts = [];
  if (reads) parts.push(`Read ${reads} file${reads === 1 ? '' : 's'}`);
  if (searches) parts.push(`${reads ? 'searched' : 'Searched'} ${searches} pattern${searches === 1 ? '' : 's'}`);
  const names = tools.map((t) => {
    const i = (t.use.input ?? {}) as Record<string, unknown>;
    if (typeof i.file_path === 'string') return base(i.file_path);
    if (typeof i.pattern === 'string') return i.pattern;
    const c = command(t.use.input) ?? '';
    const arg = c.trim().split(/\s+/).filter((w) => !w.startsWith('-')).pop() ?? c;
    return isSearch(t) ? arg : base(arg);
  });
  return [parts.join(', '), names.join(', ')];
}

const WORK = new Set<Row['kind']>(['tool', 'group', 'task', 'orphan']);
// Recognize even unfinished/background test runs so they clear an earlier pass count.
const TEST_CMD = /^(?:(?:npx|(?:pnpm|npm|yarn)\s+exec|bunx)\s+(?:playwright\s+test|vitest(?:\s+run)?|jest)|(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+test|(?:python3?\s+-m\s+)?pytest|vitest(?:\s+run)?|jest|cargo\s+test|go\s+test)(?=\s|$|[;&|<>`$()])/;
const testRun = (t: Tool) => {
  const c = command(t.use.input)?.trim() ?? '';
  return TEST_CMD.test(c);
};

function passedTests(t: Tool): string | null {
  if (!testRun(t) || !t.result || t.result.is_error || /[;&|<>`$()\n\r]/.test(command(t.use.input) ?? '')) return null;
  const text = outputText(t.result.output);
  let output: string;
  if (t.use.name === 'Bash') {
    if ((t.use.input as { run_in_background?: boolean })?.run_in_background || /Command running in background|<task_id>/.test(text)) return null;
    output = text; // Claude's non-error tool_result is the completion receipt.
  } else try {
    const receipt = JSON.parse(text);
    if (!receipt || receipt.metadata?.exit_code !== 0 || receipt.session_id != null || typeof receipt.output !== 'string') return null;
    output = receipt.output;
  } catch {
    const receipt = /^(?:Chunk ID: [^\n]+\n)?Wall time: [^\n]+\nProcess exited with code 0\n(?:Final output:\n)?([\s\S]*)$/.exec(text);
    if (!receipt) return null;
    output = receipt[1];
  }
  if (/\b[1-9]\d*\s+failed\b/.test(output)) return null;
  const count = [...output.matchAll(/\b(\d+)\s+passed\b/g)].pop();
  return count ? `${count[1]} passed` : null;
}

function editSucceeded(row: Extract<Row, { kind: 'diff' }>): boolean {
  const tool = row.tool;
  if (!tool?.result || tool.result.is_error) return false;
  // Claude's non-error result confirms success, including Write's empty structuredPatch.
  if (['Edit', 'MultiEdit', 'Write'].includes(tool.use.name)) return true;
  // Look 11-17 N21: Codex 0.161 patches through `tools.apply_patch(` in its exec script; a script that threw does not
  // say "Script completed".
  if (tool.use.name === 'exec') return /^Script completed\b/.test(outputText(tool.result.output));
  if (tool.use.name !== 'apply_patch') return false;
  let output = outputText(tool.result.output);
  try {
    const receipt = JSON.parse(output);
    if (!receipt || (receipt.metadata?.exit_code !== undefined && receipt.metadata.exit_code !== 0)) return false;
    output = typeof receipt.output === 'string' ? receipt.output : '';
  } catch {
    // Plain apply_patch results carry their own Success status.
  }
  return /^Success(?:[.!]|\r?\n|$)/.test(output);
}

const ABORTED = /^aborted by user\b/;
/** Codex's second ask for a command its sandbox refused, in an `exec` script (a string) or in a call's own fields. */
const ESCALATED = /\bsandbox_permissions\W+require_escalated\b/;
/** A command result that says it did not succeed (the sandbox's refusal is a non-zero exit). */
const FAILED_EXIT = /"exit_code":\s*-?[1-9]/;
/** Claude's words for a call the user rejected, a hook's deny note (sessions.rs DENY_NOTE_FOLLOWS), Codex's rejection. */
const REFUSED = /^(The user doesn't want to proceed with this tool use|The user denied this|Permission to use \S+ (?:with .* )?has been denied)|\brejected by (?:the )?user\b/i;
function refused(t: Tool): boolean {
  return !!t.result?.is_error && REFUSED.test(outputText(t.result.output).trim());
}

function toolsOf(r: Row): Tool[] {
  return r.kind === 'group' ? r.tools : (r.kind === 'tool' || r.kind === 'task' || (r.kind === 'diff' && !r.more)) && r.tool ? [r.tool] : [];
}

/** Counts for one turn, its last test result, and the span of its tool results' times. */
/** One count of a turn's summary line, worded by the window's catalogue (`summaryLabel`). */
export type SummaryPart = ['read' | 'edited' | 'edit' | 'searched' | 'ran' | 'asking' | 'askingCall' | 'denied' | 'task' | 'other', number];
/** "Read 2 files, edited 1, used 1 other tool" in the window's language (Q5: the line was an English literal). */
export function summaryLabel(parts: SummaryPart[], t: T): string {
  // Look 1117 v4 (B S3-1): "edited 1 file", as "read 1 file" says what it read.
  const text = parts.map(([k, n]) => t(`turnsum.${k}.${n === 1 ? 'one' : 'other'}`, { n })).join(t('turnsum.join'));
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function summarize(work: Row[], stopped = false, asking = 0): { parts: SummaryPart[]; tests: string | null; seconds: number | null } {
  const tools = work.flatMap(toolsOf);
  // Sixth look (B6-S3-2) and its follow-up: while the session waits for the user's answer to a request (its card is up, or
  // Deny's note box is open), the call that asks has not run. The line says it waits ("1 command waiting for your answer",
  // for any other call "1 request…"), never "ran", "read", "searched", "1 edit" or "used". A task is not a call that
  // asks: it stays a task while a call inside it waits.
  // shortcut: calls of the asking turn with no result yet read as waiting, commands first; upgrade when the request names its call.
  // Look v36 (S3-4): never more than the session's pending requests. Claude's REPL runs Edit inside a script and Poll waits
  // on it, so one Edit request left two calls with no result ("2 requests waiting" above one card).
  const held = (t: Tool | undefined) => asking > 0 && !stopped && !!t && !t.result && !TASKS.has(t.use.name);
  const asked = tools.filter(held);
  const askedCommands = asked.filter((t) => command(t.use.input) !== null).length;
  const waits = Math.min(asking, askedCommands);
  const calls = Math.min(asking - waits, asked.length - askedCommands);
  const edits = work.filter((r): r is Extract<Row, { kind: 'diff' }> => r.kind === 'diff' && !held(r.tool));
  // Seventh look (B S2-2): Codex tries a command in its sandbox first; refused there, it asks for the same command again
  // with `require_escalated`. That is one command: the failed first try is its request, not a run ("Ran 1 command, 1 command
  // waiting" for one waiting command, "Ran 2 commands" for one that ran).
  const tries = new Set(tools.filter((t, i) => !!t.result && FAILED_EXIT.test(outputText(t.result.output)) && command(t.use.input) !== null && !!tools[i + 1] && ESCALATED.test(JSON.stringify(tools[i + 1].use.input)) && command(tools[i + 1].use.input) === command(t.use.input)));
  const steps = work.filter((r) => r.kind !== 'diff').flatMap(toolsOf).filter((t) => !held(t) && !tries.has(t));
  const reads = steps.filter((t) => !isSearch(t) && (READS.has(t.use.name) || READ_CMD.test(command(t.use.input) ?? ''))).length;
  const searches = steps.filter(isSearch).length;
  const edited = new Set(edits.filter(editSucceeded).map((r) => r.edit.path)).size;
  const neutral = new Set(edits.filter((r) => !editSucceeded(r)).map((r) => r.edit.path)).size;
  const commands = steps.filter((t) => command(t.use.input) !== null && !READ_CMD.test(command(t.use.input)!));
  // Look 11-17 N18: a command the user (or a hook) refused never ran. W10 core 11: Codex's Deny is Esc, which ends the turn
  // and leaves the asking call with no result; in a turn that ended interrupted, such a call was refused too.
  // shortcut: a command stopped while it ran with no output also reads as denied; upgrade when Codex records which.
  // Look 1117 v5 (b2-S2-2): Codex's Deny gives the asking call a result of its own, "aborted by user after 37.5s".
  // shortcut: a command the user stopped while it ran reads the same; upgrade when Codex records which.
  const no = (t: Tool) => refused(t) || (stopped && !t.result) || (!!t.result && ABORTED.test(outputText(t.result.output).trim()));
  const denied = commands.filter(no).length;
  const ran = commands.filter((t) => !passedTests(t) && !no(t)).length;
  const tasks = steps.filter((t) => TASKS.has(t.use.name)).length;
  const other = steps.length - reads - searches - commands.length - tasks;
  const parts = ([['read', reads], ['edited', edited], ['edit', neutral], ['searched', searches], ['ran', ran], ['asking', waits], ['askingCall', calls], ['denied', denied], ['task', tasks], ['other', other]] as SummaryPart[]).filter(([, k]) => k > 0);
  let tests: string | null = null;
  for (const t of tools) if (testRun(t)) tests = passedTests(t);
  const times = tools.flatMap((t) => (t.result?.at ? [Date.parse(t.result.at)] : [])).filter((x) => !Number.isNaN(x));
  const seconds = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : null;
  if (!parts.length && commands.length - denied) parts.push(['ran', commands.length - denied]);
  return { parts, tests, seconds };
}

function foldTurn(turn: Row[], view: View, asking = 0): Row[] {
  const work = turn.filter((r) => WORK.has(r.kind) || (r.kind === 'diff' && !!r.tool));
  // Only confirmed edits become a changes card; unknown outcomes keep the neutral patch view.
  const done = (r: Row): r is Extract<Row, { kind: 'diff' }> => r.kind === 'diff' && editSucceeded(r);
  const finished = turn.filter(done);
  const out: Row[] = [];
  let summed = false;
  const lastDone = turn.findLastIndex(done);
  let changes: Extract<Row, { kind: 'changes' }> | undefined;
  turn.forEach((r, i) => {
    if (!summed && work.includes(r)) {
      // An edit-only turn also has a changes card at this cursor; give the summary its own anchor.
      out.push({ kind: 'summary', key: r.key - 0.5, rows: work, ...summarize(work, turn.some((x) => x.kind === 'interrupted'), asking) });
      summed = true;
    }
    if (WORK.has(r.kind)) {
      return;
    } else if (r.kind === 'thinking') {
      if (view === 'thinking') out.push(r);
    } else if (done(r)) {
      if (i === lastDone) {
        const byPath = new Map<string, { path: string; added: number; removed: number }>();
        for (const f of finished) {
          const e = byPath.get(f.edit.path) ?? { path: f.edit.path, added: 0, removed: 0 };
          e.added += f.edit.added ?? 0;
          e.removed += f.edit.removed ?? 0;
          byPath.set(f.edit.path, e);
        }
        const files = [...byPath.values()];
        changes = { kind: 'changes', key: r.key, files, added: files.reduce((a, f) => a + f.added, 0), removed: files.reduce((a, f) => a + f.removed, 0) };
      }
    } else out.push(r);
  });
  if (!changes) return out;
  // B19 (ticket 991): one changed-files card per turn, as T3's finished turn: the card with per-file +/- takes the turn's
  // "N changed files" row and opens Diff on the same turn files.
  const files = out.find((r): r is Extract<Row, { kind: 'turnfiles' }> => r.kind === 'turnfiles');
  return [...out.filter((r) => r !== files), files ? { ...changes, turn: files.files } : changes];
}

/** The rows a view shows. Verbose is every row as built; the others fold each turn (rows from one user message to the next).
 *  `asking`: how many permission requests of the session wait for the user's answer; they are the last turn's. */
export function viewRows(rows: Row[], view: View, asking = 0): Row[] {
  if (view === 'verbose') return rows;
  const out: Row[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j].kind !== 'user') j++;
    out.push(...foldTurn(rows.slice(i, j), view, j === rows.length ? asking : 0));
    i = j;
  }
  return out;
}
