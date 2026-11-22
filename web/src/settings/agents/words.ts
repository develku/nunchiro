// V2-4b: the setup sheet shows an entry as one command line and reads it back; both directions are exact, so what
// the sheet shows is the entry it adds and the hash it asks for (threat 1).

/** One word as a shell would need it (the permission sheet's rule), so the line reads back to the same words. */
export const word = (w: string) => (/^[\p{L}\p{N}_@%+=:,./-]+$/u.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`);
export const joinWords = (words: string[]) => words.map(word).join(' ');

/** The words of a line: whitespace separates; '…' is literal; "…" takes \" and \; a backslash outside quotes takes the
 * next character. Null for an unterminated quote or a dangling backslash. */
export function splitWords(line: string): string[] | null {
  const words: string[] = [];
  let cur: string | null = null;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "'") {
      const end = chars.indexOf("'", i + 1);
      if (end < 0) return null;
      cur = (cur ?? '') + chars.slice(i + 1, end).join('');
      i = end;
    } else if (c === '"') {
      cur ??= '';
      for (i++; ; i++) {
        if (i >= chars.length) return null;
        if (chars[i] === '"') break;
        if (chars[i] === '\\' && (chars[i + 1] === '"' || chars[i + 1] === '\\')) i++;
        cur += chars[i];
      }
    } else if (c === '\\') {
      if (i + 1 >= chars.length) return null;
      cur = (cur ?? '') + chars[++i];
    } else if (/\s/u.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else cur = (cur ?? '') + c;
  }
  if (cur !== null) words.push(cur);
  return words;
}

/** Control characters shown as visible escapes (`\n`, `\x07`), so a line cannot hide part of a command. */
const CONTROL = String.raw`[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]`;
export const escaped = (s: string) =>
  s.replace(new RegExp(CONTROL, 'gu'), (c) => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0' })[c] ?? `\\u{${c.codePointAt(0)!.toString(16)}}`);
export const hasControl = (s: string) => new RegExp(CONTROL, 'u').test(s);

/** The core's env rule for a new entry (acp/add.rs): names only. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** The core's agent-name rule (approval `valid_name`). */
export const validAgentName = (n: string) => /^[a-z0-9][a-z0-9_-]*$/.test(n) && n.length <= 64;
