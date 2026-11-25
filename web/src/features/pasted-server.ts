// Ticket 1123 T10: a pasted line as one of Nunchiro's own MCP servers. Nothing here runs the line; the result is what the
// Add button sends (extensions_mcp_add), so a line that would make an agent CLI itself the server is refused, never saved.
import { hasControl, joinWords, splitWords, word } from '../settings/agents/words';

/** `refused`: `agent` a claude or codex line other than a stdio `claude mcp add` (saving it would run the agent CLI in every
 *  new session and write the agent's own config); `remote` an http or sse add (no command to run). `dropped`: the names
 *  of the -e/--env values left out (an own server has no env, and extensions.rs keeps env out of its file). */
export type Pasted = { name: string; command: string[]; refused?: 'agent' | 'remote'; dropped: string[] };

/** `claude mcp add` options that take a value (Claude Code's own help); -e/--env takes one or more KEY=VALUE words. */
const VALUED = /^(-s|--scope|-t|--transport|-e|--env|-H|--header|--client-id|--callback-port)$/;
const ENV_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function pastedServer(argv: string[]): Pasted {
  const program = argv[0]?.split('/').pop() ?? '';
  if (program === 'claude' || program === 'codex') {
    if (program !== 'claude' || argv[1] !== 'mcp' || argv[2] !== 'add') return { name: '', command: [], refused: 'agent', dropped: [] };
    // Options may sit anywhere before "--" (claude accepts "add my-server -e KEY=V -- cmd").
    const dash = argv.indexOf('--', 3);
    const head = dash < 0 ? argv.slice(3) : argv.slice(3, dash);
    const words: string[] = [];
    const dropped: string[] = [];
    let transport = 'stdio';
    for (let i = 0; i < head.length; i++) {
      const [flag, inline] = head[i].startsWith('--') && head[i].includes('=') ? [head[i].slice(0, head[i].indexOf('=')), head[i].slice(head[i].indexOf('=') + 1)] : [head[i], undefined];
      if (!flag.startsWith('-')) {
        words.push(flag);
        continue;
      }
      if (!VALUED.test(flag)) continue; // a switch with no value
      const value = inline ?? head[++i] ?? '';
      if (flag === '-t' || flag === '--transport') transport = value;
      if (flag === '-e' || flag === '--env') {
        dropped.push(value.split('=')[0]);
        while (inline === undefined && ENV_WORD.test(head[i + 1] ?? '')) dropped.push(head[++i].split('=')[0]);
      }
    }
    if (transport !== 'stdio') return { name: words[0] ?? '', command: [], refused: 'remote', dropped };
    return { name: words[0] ?? '', command: dash < 0 ? words.slice(1) : argv.slice(dash + 1), dropped };
  }
  const runner = /^(npx|bunx|pnpx|uvx)$/.test(program);
  const pkg = (runner ? argv.slice(1).find((w) => !w.startsWith('-')) : argv[0]) ?? '';
  const [scope, base] = pkg.startsWith('@') ? [pkg.slice(1).split('/')[0], pkg.split('/')[1] ?? ''] : ['', pkg.split('/').pop() ?? ''];
  const bare = base.replace(/@[^@]*$/, '').replace(/\.[a-z]+$/, '').replace(/^(mcp-server-|server-|mcp-)|(-mcp-server|-server|-mcp)$/g, '');
  const name = (bare && bare !== 'mcp' ? bare : scope || bare).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return { name, command: argv, dropped: [] };
}

/** Ticket 1130 C6 (owner Q2): the composer's offer for pasted text. Only one stdio `claude mcp add NAME -- COMMAND` line
 *  offers (owner's words: a pasted `claude mcp add` line); a bare command, prose, a refused line or a line that hides
 *  control characters stays an ordinary prompt. `line` is the trimmed text, which leaves the box once it is added. */
export function composerOffer(text: string): (Pasted & { line: string }) | null {
  const line = text.trim();
  const words = line.includes('\n') ? null : splitWords(line);
  if (!words || words[0]?.split('/').pop() !== 'claude' || words[1] !== 'mcp' || words[2] !== 'add') return null;
  const p = pastedServer(words);
  if (p.refused || !p.name || !p.command.length || [p.name, ...p.command].some(hasControl)) return null;
  return { line, ...p };
}

/** Ticket 1130 round 2: a draft as it may be stored. Each offered line that carries -e/--env values is stored as the line
 *  the add would save (`claude mcp add NAME -- COMMAND`), so a pasted secret never reaches localStorage. */
export const withoutEnvValues = (text: string) =>
  text
    .split('\n')
    .map((l) => {
      const o = composerOffer(l);
      return o?.dropped.length ? `claude mcp add ${word(o.name)} -- ${joinWords(o.command)}` : l;
    })
    .join('\n');
