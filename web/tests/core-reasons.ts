// Ticket 601: the refusal reasons written in the core source, for errors-core-reasons.spec.ts. A reason is a string literal
// handed to `Err(`, `.ok_or(`, `.ok_or_else(||`, `bail!(`, `.map_err(|x|`, a refusal helper (`refuse(`, `refused(`, `fail(`,
// `reject(`) or a `|| format!(` closure, in non-test code. `text` has each `{...}` slot as `7` (`"7"` for a `{:?}` slot, Rust's
// quoted form), so a pattern that wants a number or a name still matches; `template` keeps the slot as `{}`.
// What it cannot see: a reason with no literal (`Err(e)`, a `String` built by a helper that returns it, `.to_string()` of
// another error), and a literal split over `concat!` or a `const` (a `const X: &str` handed to `Err(X)`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_SRC = fileURLToPath(new URL('../../crates/nunchiro-core/src', import.meta.url));
export type Reason = { file: string; line: number; text: string; template: string };

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.rs') && !/(^|_)tests?\.rs$/.test(e.name) ? [path.join(dir, e.name)] : []));

const LITERAL = /(?:Err\(|ok_or\(|ok_or_else\(\|\|\s*|bail!\(|map_err\(\|\w+\|\s*|\b(?:refuse|refused|fail|reject)\(|\|\|\s*(?=format!))\s*(?:format!\(\s*|String::from\(\s*)?"((?:[^"\\]|\\.)*)"/g;

export function coreReasons(): Reason[] {
  const out: Reason[] = [];
  for (const abs of walk(CORE_SRC)) {
    // `#[cfg(test)] mod x { ... }` at column 0 ends at the first `}` at column 0 (rustfmt layout); blank the body, keep the line count.
    const src = fs.readFileSync(abs, 'utf8').replace(/^#\[cfg\(test\)\]\n(?:pub )?mod \w+ \{\n[\s\S]*?^\}\n/gm, (m) => m.replace(/[^\n]/g, ''));
    for (const m of src.matchAll(LITERAL)) {
      const template = m[1]
        .replace(/\\\n\s*/g, '')
        .replace(/\\n/g, ' ')
        .replace(/\\(["\\])/g, '$1')
        .replace(/\{[^{}]*:\?\}/g, '"{}"')
        .replace(/\{[^{}]*\}/g, '{}')
        .trim();
      const text = template.replace(/\{\}/g, '7');
      if (/\p{L}/u.test(text)) out.push({ file: path.relative(CORE_SRC, abs), line: src.slice(0, m.index).split('\n').length, text, template });
    }
  }
  return out;
}
