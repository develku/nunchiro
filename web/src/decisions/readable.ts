// Ticket 991 (B4, B5, B7): what a decision card shows, in words. A hook item's text is the tool's JSON input and a screen
// item's is the whole terminal screen (the agent's banner, earlier output); the card shows the request itself. Display
// only: the answer, the risk rule and the re-file check read the raw item.
import type { T } from '../i18n';
import type { Item } from '../tree/decisions';

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const json = (text: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** A plan's first line without its Markdown heading marks ("# Create plan.txt" → "Create plan.txt"). */
export const planTitle = (plan: string) => (plan.split('\n').find((l) => l.trim()) ?? '').replace(/^\s*#+\s*/, '').trim();
const lines = (s: string, mark: string) => (s ? s.replace(/\n$/, '').split('\n').map((l) => mark + l) : []);

/** Look v31 a S2-1: an MCP tool's server and tool in plain words, from the hook's name (the core's `tool`):
 *  `mcp__claude_ai_Gmail__search_threads` is "Gmail" and "search threads" (a claude.ai connector's prefix is dropped).
 *  Null for a built-in tool and for an item read from the screen. */
export function mcpTool(d: { tool?: string }): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(d.tool ?? '');
  const words = (s: string) => s.replace(/_+/g, ' ').trim();
  return m ? { server: words(m[1].replace(/^claude_ai_/, '')), tool: words(m[2]) } : null;
}
/** An MCP tool's one line: its server, its tool and its input's first words ("Gmail · search threads · in:inbox"). */
export function mcpLine(d: { tool?: string; text: string }): string | null {
  const m = mcpTool(d);
  const arg = Object.values(json(d.text) ?? {}).find((x) => typeof x === 'string' && x.trim());
  return m && [m.server, m.tool, str(arg).trim().split('\n')[0]].filter(Boolean).join(' · ');
}

/** Ticket 1030 (permcard-1121 "Bash · npm test"): a built-in tool's name and its argument for the card above the
 *  composer. The core names only MCP tools (`tool`), so a hook item's tool is read from its input's shape and a screen
 *  item's from Claude's "Bash command" header. Null when neither says it (the card then shows its line as is). */
export function toolOf(d: Item, what: string): { tool: string; arg: string } | null {
  if (mcpTool(d)) return null;
  const v = json(d.text);
  if (v) {
    if (typeof v.command === 'string') return { tool: 'Bash', arg: v.command.trim().split('\n')[0] };
    const file = str(v.file_path) || str(v.notebook_path);
    if (!file) return null;
    return { tool: v.notebook_path ? 'NotebookEdit' : typeof v.content === 'string' && !('old_string' in v) ? 'Write' : 'Edit', arg: file };
  }
  return /^\s*Bash command\b/m.test(promptPart(d.text)) ? { tool: 'Bash', arg: what } : null;
}

/** A screen item's prompt: what follows the agent's last full-width rule (Claude draws one above its prompt), without the
 *  blank rows around it. A screen with no such rule keeps its text from its first non-blank row. */
export function promptPart(text: string): string {
  const rows = text.split('\n');
  // From column 0 only, as the core's `prompt_region`: an indented rule is part of the request (a heredoc line).
  const rules = rows.flatMap((l, i) => (/^─{20,}\s*$/.test(l) ? [i] : []));
  // Look 11-17 N1, as the core: Claude 2.1.326 draws a second rule above "4. Chat about this"; the part starts at the
  // last rule with the option list's first row ("1.") below it.
  const first = rules.findLast((r) => rows.slice(r + 1).some((l) => /^\s*[❯›>○●]?\s*1[.)]\s/.test(l)));
  const rule = first ?? rules.at(-1) ?? -1;
  const part = rows.slice(rule + 1);
  while (part.length && !part[0].trim()) part.shift();
  while (part.length && !part.at(-1)!.trim()) part.pop();
  return part.join('\n');
}

/** The card's one line ("Edit app.py", the command, the question) and its body (the request as the person reads it). */
export function readable(d: Item, t: T): { what: string; body: string; path?: string } | null {
  if (d.board || d.owner || d.kind === 'stale' || d.kind === 'background') return null;
  const v = json(d.text);
  if (v) {
    // Look v31 a S2-1: an MCP tool's input is that server's own fields: none is read as a command, a file or a plan.
    // The card's line is the tool's name (`whatWhy`), and the input shows whole.
    if (mcpTool(d)) return { what: '', body: JSON.stringify(v, null, 2) };
    const file = str(v.file_path) || str(v.notebook_path);
    // A field the words below do not show (`replace_all: true` turns one replacement into every occurrence, a command
    // may ask to run outside the sandbox) keeps the request whole: the words stand for the request only when they
    // say all of it. A command's description and timeout change nothing it does.
    const only = (o: Record<string, unknown>, keys: string[]) => Object.entries(o).every(([k, x]) => keys.includes(k) || x === false || x == null);
    // Look 1117 v10 N10-S2-5: Claude's plan approval (ExitPlanMode) shows its plan as written, line by line.
    if (typeof v.plan === 'string') return { what: planTitle(v.plan) || t('decisions.kindQuestion'), body: v.plan };
    if (typeof v.command === 'string') return { what: v.command.split('\n')[0], body: only(v, ['command', 'description', 'timeout']) ? v.command : JSON.stringify(v, null, 2) };
    const raw = Array.isArray(v.questions) ? v.questions : typeof v.question === 'string' ? [v] : null;
    // A malformed entry (not an object) is not read as a question: the request shows whole below.
    const qs = raw?.every((q: unknown) => !!q && typeof q === 'object') ? (raw as Record<string, unknown>[]) : null;
    if (qs) {
      const body = qs.flatMap((q: Record<string, unknown>) => [
        str(q.question) || str(q.title),
        ...(Array.isArray(q.options) ? q.options : []).map((o: unknown, i: number) => {
          const opt = (typeof o === 'string' ? { label: o } : (o ?? {})) as Record<string, unknown>;
          return `${i + 1}. ${str(opt.label)}${str(opt.description) ? ` — ${str(opt.description)}` : ''}`;
        }),
      ]);
      return { what: str(qs[0]?.question) || str(qs[0]?.title) || t('decisions.kindQuestion'), body: body.join('\n') };
    }
    // After one Codex look: the body starts with the whole path (the title has only the file's name, and the same
    // name in the project and in an agent's config folder must not read the same), and a request this does not know
    // by its fields (a notebook cell edit) shows whole, never as an empty body.
    if (file && typeof v.content === 'string' && only(v, ['file_path', 'content'])) return { what: t('decisions.whatWrite', { file: base(file) }), body: `${file}\n${v.content}`, path: file };
    const known = (e: unknown) => {
      const o = e as Record<string, unknown> | null;
      return !!o && typeof o === 'object' && (typeof o.old_string === 'string' || typeof o.new_string === 'string') && only(o, ['file_path', 'old_string', 'new_string', 'edits', 'replace_all']) && (o.replace_all == null || typeof o.replace_all === 'boolean');
    };
    if (file && !v.notebook_path && (Array.isArray(v.edits) ? v.edits.length > 0 && v.edits.every(known) && only(v, ['file_path', 'edits']) : known(v))) {
      const edits = Array.isArray(v.edits) ? v.edits : [v];
      // Look 1117 v10 N10-S3-7: `replace_all` is said in words above its lines, so the edit is not raw JSON.
      const body = edits.flatMap((e: Record<string, unknown>) => [...(e?.replace_all === true ? [t('decisions.everyPlace')] : []), ...lines(str(e?.old_string), '-'), ...lines(str(e?.new_string), '+')]);
      return { what: t('decisions.whatEdit', { file: base(file) }), body: [file, ...body].join('\n'), path: file };
    }
    return { what: file ? t('decisions.whatEdit', { file: base(file) }) : '', body: JSON.stringify(v, null, 2), path: file || undefined };
  }
  const body = promptPart(d.text);
  const flat = body.replace(/\s+/g, ' ');
  // Claude's file prompts name their file in the question.
  const edit = /do you want to make this edit to (.+?)\?/i.exec(flat);
  const create = /do you want to (?:create|overwrite) (.+?)\?/i.exec(flat);
  if (edit) return { what: t('decisions.whatEdit', { file: edit[1] }), body };
  if (create) return { what: t('decisions.whatWrite', { file: create[1] }), body };
  // w25-m: Claude cut its start question off in a short window (only "No" takes there); the line says what to do.
  // w25-s: so is one whose heading a narrow window scrolled off (its "No, exit" row without its question).
  const headless = /\bNo, exit\b/.test(flat) && !/one you trust\?|trust this folder\?/i.test(flat);
  if (d.kind === 'dialog' && (headless || /first make the window taller/i.test(flat))) return { what: t('decisions.windowShort'), body };
  // Another permission keeps the row's line (the command). A dialog or a question: its own question; a dialog's is read
  // from the start of its sentence ("Trust this folder?").
  if (d.kind !== 'dialog' && d.kind !== 'question') return { what: '', body };
  const asked = askedOn(body);
  // Sixth look (B6-S3-3): a question card's line is the question the agent asked ("Which name should I use …: alpha or
  // beta?" was cut to "alpha or beta?"); only a dialog's is cut to its last sentence.
  if (d.kind === 'question') return { what: asked, body };
  const question = asked && /(?:^|[.:!]\s)((?:[^.:!?]|[.:!](?!\s))*\?)/.exec(asked.slice(0, asked.indexOf('?') + 1));
  return { what: question ? question[1].trim() : '', body };
}

/** Look 1117 v10 Home S3-1: what a question card's box adds to its line and its option buttons ('' when nothing). The
 *  question's own rows, options whose label is a button, rules, the header chip and the key hint are not counted; an
 *  option's description is. */
export function questionRest(body: string, what: string, labels: string[]): string {
  const q = what.replace(/\s+/g, ' ');
  const names = new Set(labels.map((l) => l.trim()));
  return body
    .split('\n')
    .map((l) => l.trim().replace(/^[│┃╭╮╰╯─━┌┐└┘]+\s*/, '').replace(/\s*[│┃╮╯┐┘]+$/, '').trim())
    .filter((l) => {
      if (!l || /^[☐☒✔]/.test(l) || /\bEsc to\b/.test(l)) return false;
      const opt = /^[❯›>○●]?\s*\d+[.)]\s+(.*)$/.exec(l);
      return opt ? !names.has(opt[1].trim()) : !q.includes(l.replace(/\s+/g, ' '));
    })
    .join('\n');
}

/** The paragraph of a screen prompt (`promptPart`) that asks: up to its first row with a question mark; '' when no row asks. */
export function askedOn(body: string): string {
  // N9 (look 1117 v4): a framed screen's gutter and borders are no part of the question ("What │ What text…").
  const rows = body.split('\n').map((l) => l.trim().replace(/^[│┃╭╮╰╯─━┌┐└┘]+\s*/, '').replace(/\s*[│┃╮╯┐┘]+$/, '').trim());
  const at = rows.findIndex((l) => l.includes('?') && !/^[❯›>○●]?\s*\d+[.)]/.test(l));
  // A question the terminal wrapped is read from the start of its paragraph (look 11-17 N1).
  let from = at;
  while (from > 0 && rows[from - 1] && !/^[─☐☒✔]/.test(rows[from - 1])) from--;
  return at < 0 ? '' : rows.slice(from, at + 1).join(' ');
}
