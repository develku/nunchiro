// Unified patch text from the core (`diff_file`) into display rows, unified or split.
// Line model and row layout adapted from MonoCode (src/features/source-control/model/unifiedDiff.ts and
// ui/UnifiedDiffView.tsx), MIT License, Copyright (c) 2026 Nick. MonoCode diffs two texts in the browser;
// here git's own hunks are parsed instead, so the window never needs the file contents.
//
// MonoCode's notice:
//
// MIT License
//
// Copyright (c) 2026 Nick
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export type LineKind = 'add' | 'del' | 'context' | 'hunk' | 'note' | 'fold';

export type DiffLine = {
  kind: LineKind;
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
  /** A `fold` line's unchanged lines (ticket 261). */
  hidden?: DiffLine[];
};

/** One split-view row: a deletion beside the addition that replaced it; hunks and notes span both sides. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const h = HUNK.exec(raw);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    // File headers (`diff --git`, `index`, `---`, `+++`, rename lines) come before the first hunk.
    if (!inHunk || raw === '') continue;
    const text = raw.slice(1);
    if (raw[0] === '+') out.push({ kind: 'add', text, oldNumber: null, newNumber: newN++ });
    else if (raw[0] === '-') out.push({ kind: 'del', text, oldNumber: oldN++, newNumber: null });
    else if (raw[0] === ' ') out.push({ kind: 'context', text, oldNumber: oldN++, newNumber: newN++ });
    else if (raw[0] === '\\') out.push({ kind: 'note', text: raw.slice(2), oldNumber: null, newNumber: null });
  }
  return out;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'del' || l.kind === 'add') {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (lines[i]?.kind === 'del') dels.push(lines[i++]);
      while (lines[i]?.kind === 'add') adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
      continue;
    }
    rows.push({ left: l, right: l });
    i++;
  }
  return rows;
}

// Ticket 261 (G14): view options over the parsed lines; git's patch is unchanged, so line numbers stay git's.
const squash = (s: string) => s.replace(/\s+/g, ''); // git diff -w: all whitespace is ignored

/** Hide whitespace: within each run of removals then additions, a removed and an added line at the same place that are
 *  equal once whitespace is ignored become one context line (the new text); a hunk left with no change keeps its
 *  header and shows `note` in place of its lines. */
export function hideWhitespace(lines: DiffLine[], note: string): DiffLine[] {
  const out: DiffLine[] = [];
  let hunk = -1; // where the current hunk's header sits in `out`
  const close = () => {
    if (hunk >= 0 && !out.slice(hunk + 1).some((l) => l.kind === 'add' || l.kind === 'del')) out.splice(hunk + 1, out.length, { kind: 'note', text: note, oldNumber: null, newNumber: null });
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'hunk') {
      close();
      hunk = out.length;
      out.push(l);
      i++;
      continue;
    }
    if (l.kind !== 'del' && l.kind !== 'add') {
      out.push(l);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === 'del') dels.push(lines[i++]);
    while (lines[i]?.kind === 'add') adds.push(lines[i++]);
    let d: DiffLine[] = [];
    let a: DiffLine[] = [];
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      if (dels[k] && adds[k] && squash(dels[k].text) === squash(adds[k].text)) {
        out.push(...d, ...a, { kind: 'context', text: adds[k].text, oldNumber: dels[k].oldNumber, newNumber: adds[k].newNumber });
        d = [];
        a = [];
      } else {
        if (dels[k]) d.push(dels[k]);
        if (adds[k]) a.push(adds[k]);
      }
    }
    out.push(...d, ...a);
  }
  close();
  return out;
}

/** Collapse unchanged: in each run of context lines, `keep` lines next to a change stay and the rest fold into one
 *  `fold` line holding them in `hidden`, when at least `min` lines would fold (a smaller fold saves nothing). */
export function collapseUnchanged(lines: DiffLine[], keep = 1, min = 2): DiffLine[] {
  const out: DiffLine[] = [];
  const change = (l?: DiffLine) => l?.kind === 'add' || l?.kind === 'del';
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'context') {
      out.push(lines[i++]);
      continue;
    }
    const start = i;
    while (lines[i]?.kind === 'context') i++;
    const run = lines.slice(start, i);
    const head = change(lines[start - 1]) ? keep : 0;
    const tail = change(lines[i]) ? keep : 0;
    if (run.length - head - tail < min) {
      out.push(...run);
      continue;
    }
    const hidden = run.slice(head, run.length - tail);
    out.push(...run.slice(0, head), { kind: 'fold', text: '', oldNumber: hidden[0].oldNumber, newNumber: hidden[0].newNumber, hidden }, ...run.slice(run.length - tail));
  }
  return out;
}
