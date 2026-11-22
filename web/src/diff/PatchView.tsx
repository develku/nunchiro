// One file's patch as table rows, unified or split (spec B3 Diff). Ticket 374: syntax colours from the Files viewer's
// highlighter, and a note on a changed line that goes to the composer (never sent from here).
import { PLAIN } from '../plainText';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Span } from '../files/highlight';
import type { T } from '../i18n';
import type { Patch } from './Diff';
import { formatLineNote } from './lineNote';
import { collapseUnchanged, hideWhitespace, parsePatch, splitRows, type DiffLine } from './patch';
import { ErrorDetails, plainError } from '../errors';

// Carriage returns stay visible, so a CRLF line ending reads as a change.
const show = (t: string) => t.replace(/\r/g, '␍');

/** Spans per line number for one side of the patch, or null until the highlighter answers. */
type Colours = { old: Map<number, Span[]>; new: Map<number, Span[]> };

/** One side's lines as one text, its spans cut back into lines by offset (shiki tokens never cross a line). */
function sideSpans(lines: DiffLine[], spans: Span[], num: 'oldNumber' | 'newNumber'): Map<number, Span[]> {
  const out = new Map<number, Span[]>();
  let j = 0;
  let start = 0;
  for (const l of lines) {
    const end = start + l.text.length;
    const mine: Span[] = [];
    while (j < spans.length && spans[j].from < end) {
      const s = spans[j++];
      if (s.from >= start) mine.push({ ...s, from: s.from - start, to: Math.min(s.to, end) - start });
    }
    if (mine.length) out.set(l[num]!, mine);
    start = end + 1; // the joining newline
  }
  return out;
}

/** shortcut: each side is highlighted as its hunks joined, so a string or comment opened in an unshown line colours the
 *  rest wrongly (colours only, never an error); upgrade by highlighting the whole old and new files if it shows up. */
function useColours(parsed: DiffLine[], name: string): Colours | null {
  const [got, setGot] = useState<{ parsed: DiffLine[]; colours: Colours } | null>(null);
  useEffect(() => {
    if (!parsed.length) return;
    let live = true;
    const olds = parsed.filter((l) => l.kind === 'del' || l.kind === 'context');
    const news = parsed.filter((l) => l.kind === 'add' || l.kind === 'context');
    void import('../files/highlight')
      .then(({ highlight }) => Promise.all([highlight(olds.map((l) => l.text).join('\n'), name), highlight(news.map((l) => l.text).join('\n'), name)]))
      .then(([o, n]) => live && setGot({ parsed, colours: { old: sideSpans(olds, o, 'oldNumber'), new: sideSpans(news, n, 'newNumber') } }))
      .catch(() => {}); // Plain text stays readable when a grammar fails to load.
    return () => {
      live = false;
    };
  }, [parsed, name]);
  return got?.parsed === parsed ? got.colours : null;
}

/** A changed line's note target: the line number Orca's format names (new, else old). */
const lineOf = (l: DiffLine) => l.newNumber ?? l.oldNumber!;

/** `open(line)` opens the file at that line (a removed line: the next line that has one). `quote` puts text in the
 *  composer; without it the note button shows disabled (the agent is not running). */
export function PatchView({ patch, error, mode, ws, wrap, collapse, t, open, quote }: { patch: Patch | null; error: string; mode: 'unified' | 'split'; ws: boolean; wrap: boolean; collapse: boolean; t: T; open?: (line?: number) => void; quote?: (text: string) => void }) {
  const parsed = useMemo(() => (patch?.patch ? parsePatch(patch.patch) : []), [patch]);
  const colours = useColours(parsed, patch?.path ?? '');
  // The changed line with an open note field: its side and line number.
  const [noting, setNoting] = useState<{ side: 'old' | 'new'; n: number } | null>(null);
  // Folds opened with "Show N lines", by the first hidden line's old number; a new patch or whitespace choice folds again.
  const from = `${patch?.path}\u0000${patch?.patch}\u0000${ws}`;
  const [shown, setShown] = useState<{ from: string; open: Set<number | null> }>({ from: '', open: new Set() });
  const opened = useMemo(() => (shown.from === from ? shown.open : new Set<number | null>()), [shown, from]);
  const visible = useMemo(() => (ws ? hideWhitespace(parsed, t('diffopt.wsOnly')) : parsed), [parsed, ws, t]);
  const lines = useMemo(
    () => (collapse ? collapseUnchanged(visible).flatMap((l) => (l.kind === 'fold' && opened.has(l.oldNumber) ? l.hidden! : [l])) : visible),
    [visible, collapse, opened],
  );
  // hideWhitespace turns one removed and one added line into context, so each hidden change is one removal fewer.
  const removals = (ls: DiffLine[]) => ls.filter((l) => l.kind === 'del').length;
  const wsHidden = removals(parsed) - removals(visible);
  const span = mode === 'unified' ? 3 : 4;
  const foldRow = (l: DiffLine, key: number) => (
    <tr key={key} className="fold">
      <td colSpan={span}>
        <button type="button" className="dfold" onClick={() => setShown({ from, open: new Set(opened).add(l.oldNumber) })}>
          {t(l.hidden!.length === 1 ? 'diffopt.show.one' : 'diffopt.show.other', { n: l.hidden!.length })}
        </button>
      </td>
    </tr>
  );
  const sideOf = (l: DiffLine): 'old' | 'new' => (l.kind === 'del' ? 'old' : 'new');
  const spansOf = (l: DiffLine | null) => (!l || !colours ? undefined : l.kind === 'del' ? colours.old.get(l.oldNumber!) : colours.new.get(l.newNumber!));
  // Q9 ko-J20-3: a noted line that hide-whitespace turns into context (it keeps both numbers) keeps its field.
  const isNoting = (l: DiffLine | null) => !!l && !!noting && (noting.side === 'old' ? l.kind !== 'add' && l.oldNumber === noting.n : l.kind !== 'del' && l.newNumber === noting.n);
  /** The + on a changed line: in its number cell, shown on row hover or keyboard focus. */
  const plus = (l: DiffLine | null) =>
    l && (l.kind === 'add' || l.kind === 'del') ? (
      <button
        type="button"
        className="dplus"
        aria-label={t('diffview.note', { n: lineOf(l) })}
        aria-disabled={quote ? undefined : 'true'}
        data-tip={quote ? undefined : t('diffview.noteOff')}
        onClick={() => quote && setNoting({ side: sideOf(l), n: lineOf(l) })}
      >
        +
      </button>
    ) : null;
  // Q9 ko-J20-2: one note row at a time, keyed 'note' (not by row index), so a refresh that shifts rows keeps its input.
  const noteRow = (key: string) =>
    noting && patch && quote ? (
      <tr key={key} className="dnoterow">
        <td colSpan={span}>
          <NoteField label={t('diffview.noteField', { path: patch.path, n: noting.n })} hint={t('diffview.noteHint')} onCancel={() => setNoting(null)} onAdd={(body) => (setNoting(null), quote(formatLineNote(patch.path, noting.n, body)))} />
        </td>
      </tr>
    ) : null;
  if (error)
    return (
      <div className="empty dstate">
        {t('mw.diff.cannot', { error: plainError(t, error) })}
        <ErrorDetails t={t} details={error} />
      </div>
    );
  if (!patch) return <div className="empty dstate">{t('mw.diff.loading')}</div>;
  if (patch.binary) return <div className="empty dstate">{t('mw.diff.binaryFile')}</div>;
  if (patch.too_large) return <div className="empty dstate">{t('mw.diff.tooLarge')}</div>;
  if (!lines.length) return <div className="empty dstate">{t('mw.diff.noLines')}</div>;
  return (
    <div className="dcode">
      <table className={`dl dl-${mode}${wrap ? ' wrap' : ''}`}>
        {/* A fixed split layout takes column widths from here, not from a full-width hunk row. */}
        {mode === 'split' && (
          <colgroup>
            <col className="n" />
            <col />
            <col className="n" />
            <col />
          </colgroup>
        )}
        <tbody>
          {wsHidden > 0 && (
            <tr className="note">
              <td colSpan={span}>{t(wsHidden === 1 ? 'diffopt.wsHidden.one' : 'diffopt.wsHidden.other', { n: wsHidden })}</td>
            </tr>
          )}
          {mode === 'unified'
            ? lines.flatMap((l, i) =>
                l.kind === 'fold' ? [foldRow(l, i)] : [
                <tr key={i} className={l.kind} onDoubleClick={open && l.kind !== 'hunk' && l.kind !== 'note' ? () => open(lines.slice(i).find((x) => x.newNumber !== null)?.newNumber ?? undefined) : undefined}>
                  {l.kind === 'hunk' || l.kind === 'note' ? (
                    <td colSpan={3}>{l.text}</td>
                  ) : (
                    <>
                      <td className="n">
                        {plus(l)}
                        {l.oldNumber ?? ''}
                      </td>
                      <td className="n">{l.newNumber ?? ''}</td>
                      <Code line={l} spans={spansOf(l)} t={t} />
                    </>
                  )}
                </tr>,
                isNoting(l) ? noteRow('note') : null,
              ])
            : splitRows(lines).flatMap((r, i) =>
                r.left?.kind === 'fold' ? [foldRow(r.left, i)] : r.left && r.left === r.right && (r.left.kind === 'hunk' || r.left.kind === 'note') ? [
                  <tr key={i} className={r.left.kind}>
                    <td colSpan={4}>{r.left.text}</td>
                  </tr>,
                ] : [
                  <tr key={i} onDoubleClick={open ? () => open(r.right?.newNumber ?? r.left?.newNumber ?? undefined) : undefined}>
                    <td className={`n ${r.left?.kind ?? 'gap'}`}>
                      {plus(r.left)}
                      {r.left?.oldNumber ?? ''}
                    </td>
                    <Code line={r.left} spans={spansOf(r.left)} side t={t} />
                    <td className={`n ${r.right?.kind ?? 'gap'}`}>
                      {r.right !== r.left && plus(r.right)}
                      {r.right?.newNumber ?? ''}
                    </td>
                    <Code line={r.right} spans={spansOf(r.right)} side t={t} />
                  </tr>,
                  isNoting(r.left) || (r.right !== r.left && isNoting(r.right)) ? noteRow('note') : null,
                ],
              )}
        </tbody>
      </table>
    </div>
  );
}

/** The inline note input (form behaviour after T3 Code DiffCommentAnnotation.tsx:16-30 and commentSubmitShortcut.ts,
 *  MIT): focused on open; Enter or Cmd/Ctrl+Enter adds a non-empty note, Esc cancels. */
function NoteField({ label, hint, onAdd, onCancel }: { label: string; hint: string; onAdd: (body: string) => void; onCancel: () => void }) {
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // a Korean or Japanese syllable still being composed
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const body = e.currentTarget.value.trim();
      if (body) onAdd(body);
    }
  };
  return (
    <div className="dnotebox">
      <input {...PLAIN} className="fld" type="text" aria-label={label} autoFocus onKeyDown={onKey} />
      <p>{hint}</p>
    </div>
  );
}

function Code({ line, spans, side, t }: { line: DiffLine | null; spans?: Span[]; side?: boolean; t: T }) {
  if (!line) return <td className="c gap" />;
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  const text = line.text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const s of spans ?? []) {
    if (s.from > at) parts.push(show(text.slice(at, s.from)));
    parts.push(
      <span key={s.from} className="sh" style={{ color: s.color }}>
        {show(text.slice(s.from, s.to))}
      </span>,
    );
    at = s.to;
  }
  parts.push(show(text.slice(at)));
  return (
    <td className={`c ${side ? line.kind : ''}`}>
      <span className="sign" aria-label={line.kind === 'add' ? t('mw.diff.added') : line.kind === 'del' ? t('mw.diff.removed') : undefined}>
        {sign}
      </span>
      {parts}
    </td>
  );
}
