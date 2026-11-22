// Settings > Keyboard: the recorder that works inside a row (needs 166, page A; VS Code's keybinding editor, reduced).
// Press the shortcut: a chord is recorded by its physical code; a prefix press shows the user's prefix chip and waits for
// one more key. Enter saves, Esc cancels, a held key asks Replace or Pick another, a risky chord asks for the Save button.
import { useEffect, useRef, useState } from 'react';
import { PrefixChip } from '../../KeyChip';
import type { Key } from '../../i18n';
import { bare, captureKeys, chordOf, composing, conflicts, isModifier, label, risk, RESET_CHORD, type Bindings } from '../../keys';

type T = (key: Key, args?: Record<string, string | number>) => string;

/** One binding as chips: `⌘T`, or the prefix symbol and the key. `jump` shows the nine digits as `1-9`, `arrows` the four directions. */
export function Caps({ binding, bindings, jump, arrows }: { binding: string; bindings: Bindings; jump?: boolean; arrows?: boolean }) {
  const range = (s: string) => (jump ? s.replace(/1$/, '1-9') : arrows ? s.replace(/←$/, '←→↑↓') : s);
  return binding.startsWith('prefix ') ? (
    <span className="kcaps">
      <PrefixChip bindings={bindings} /> <span className="kbd">{range(bare(binding))}</span>
    </span>
  ) : (
    <span className="kcaps">
      <span className="kbd">{range(label(binding))}</span>
    </span>
  );
}

/** A binding as one line of text: `⌘T`, or `⌃. › c` with the user's own prefix (the conflict line names keys this way). */
export const keysText = (binding: string, _bindings: Bindings) => label(binding); // `◆ b` for a key after the prefix

/** Candidate keys after the prefix, in the order the "free after" line offers them. */
const FREE_ORDER = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `Key${l}`).concat([...'0123456789'].map((d) => `Digit${d}`), ['Semicolon', 'Slash', 'Quote']);
const FREE_MAX = 8;

type State = { first: boolean; value: string | null; note: string };
const EMPTY: State = { first: false, value: null, note: '' };

export type RecorderProps = {
  t: T;
  row: { id: string; title: string; ids: string[] };
  bindings: Bindings;
  /** The binding in the slot being replaced, or null for a new one. */
  current: string | null;
  titleOf: (id: string) => string;
  /** The binding as stored for each id of the row (the nine tab jumps move together). */
  expand: (binding: string) => string[];
  onSave: (binding: string, clash: string[]) => void;
  onCancel: () => void;
  onRemove: (() => void) | null;
  /** The prefix row records direct chords only. */
  prefixRow: boolean;
  /** The tab-jump row takes a digit key only. */
  jump: boolean;
  /** The four-direction focus row takes an arrow key only. */
  arrows?: boolean;
};

/** The two cells of the row being recorded: the recorder and the fixed button column. Mounted only while recording. */
export function RecordingCells(props: RecorderProps) {
  const { t, row, bindings, current, titleOf, onSave, onCancel, onRemove } = props;
  // `first`: the prefix was pressed and one more key completes `prefix <key>`.
  const [st, setSt] = useState<State>(EMPTY);
  const live = useRef({ st, props });
  live.current = { st, props };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);
  const clashOf = (value: string | null, p: RecorderProps = props) =>
    value ? [...new Set(p.expand(value).flatMap((b) => conflicts(p.bindings, b, p.row.id)))].filter((id) => !p.row.ids.includes(id)) : [];
  const clash = clashOf(st.value);
  const warn = st.value ? risk(st.value) : null;

  useEffect(() => {
    const end = captureKeys();
    const onKey = (e: KeyboardEvent) => {
      if (composing(e) || isModifier(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      const { st: cur, props: p } = live.current;
      const chord = chordOf(e);
      if (e.code === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) return p.onCancel();
      if (chord === 'Enter' || chord === 'NumpadEnter') {
        // A bare Enter is never recorded: it saves what is recorded when nothing holds it and nothing warns.
        if (cur.value && !risk(cur.value) && !clashOf(cur.value, p).length) p.onSave(cur.value, []);
        return;
      }
      if (chord === RESET_CHORD) return setSt({ ...cur, note: p.t('settings.kbd.resetChord', { chord: '⌃⌥⇧Esc' }) });
      const prefixes = p.bindings.prefix ?? [];
      const waiting = cur.first && cur.value === null;
      let next: State;
      if (waiting) {
        if (prefixes.includes(chord)) return setSt({ ...cur, note: p.t('settings.kbd.twice', { keys: label(chord) }) });
        next = { first: true, value: `prefix ${chord}`, note: '' };
      } else if (!p.prefixRow && prefixes.includes(chord)) next = { first: true, value: null, note: '' };
      else next = { first: false, value: chord, note: '' };
      // The jump row waits for a digit (a prefix press stays pending).
      if (p.jump && next.value && !/Digit[1-9]$/.test(next.value)) next = { first: waiting, value: null, note: p.t('settings.keys.pressDigit') };
      // Any digit stands for all nine: the row keeps the slot as its first tab's key (`⌥1-9`) and writes the other eight itself.
      else if (p.jump && next.value) next = { ...next, value: next.value.replace(/Digit[1-9]$/, 'Digit1') };
      else if (p.arrows && next.value) next = /Arrow(Left|Right|Up|Down)$/.test(next.value) ? { ...next, value: next.value.replace(/Arrow\w+$/, 'ArrowLeft') } : { first: waiting, value: null, note: p.t('settings.kbd.pressArrow') };
      setSt(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      end();
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const free = FREE_ORDER.filter((c) => !Object.entries(bindings).some(([id, bs]) => id !== 'prefix' && bs.includes(`prefix ${c}`))).slice(0, FREE_MAX);
  const [before, after] = t('settings.kbd.freeAfter', { prefix: '\u0001' }).split('\u0001');
  const shown = st.value ? (
    <Caps binding={st.value} bindings={bindings} jump={props.jump} arrows={props.arrows} />
  ) : st.first ? (
    <>
      <PrefixChip bindings={bindings} /> <span className="kgt">›</span> <span className="dim">{t('settings.kbd.prefixDetected')}</span>
    </>
  ) : (
    <span className="dim">{t('settings.kbd.press')}</span>
  );
  return (
    <>
      <td>
        <div className="krec-row">
        <div className="krec" ref={box} tabIndex={-1} role="group" aria-label={t('settings.keys.keyFor', { title: row.title })}>
          <div className="krec-box" role="status">
            {shown}
          </div>
          {/* A refusal, a warning or a held key says what to do next, so the hint line makes room (one row grows by at most 80 px). */}
          <div className="krec-hint dim" hidden={!!(st.note || warn || clash.length)}>
            {t('settings.kbd.hint')}
            {st.first && st.value === null && (
              <>
                {' · '}
                {before}
                <PrefixChip bindings={bindings} />
                {after}{' '}
                {free.map((c) => (
                  <span key={c} className="kbd" data-free={c}>
                    {bare(`prefix ${c}`)}
                  </span>
                ))}
              </>
            )}
          </div>
          {st.note && (
            <div className="conflict" role="alert">
              {st.note}
            </div>
          )}
          {warn && (
            <div className="conflict warn" role="alert">
              {warn}
            </div>
          )}
          {clash.length > 0 && st.value && (
            <div className="conflict" role="alert">
              <span aria-hidden>⚠ </span>
              {t('settings.kbd.usedBy', { keys: keysText(st.value, bindings), title: clash.map(titleOf).join(', ') })}{' '}
              <button className="btn p" onClick={() => onSave(st.value!, clash)}>
                {t('settings.keys.replace')}
              </button>{' '}
              <button className="btn" onClick={() => setSt(EMPTY)}>
                {t('settings.kbd.pickAnother')}
              </button>
            </div>
          )}
        </div>
        <span className="kbtns">
          {st.value && !clash.length && (
            <button className="btn p" onClick={() => onSave(st.value!, [])}>
              {t('settings.keys.save')}
            </button>
          )}
          <button className="btn" onClick={onCancel}>
            {t('settings.keys.cancel')}
          </button>
          {onRemove && current !== null && (
            <button className="btn" onClick={onRemove}>
              {t('settings.kbd.remove')}
            </button>
          )}
        </span>
        </div>
      </td>
      <td className="kact" />
    </>
  );
}

/** A reset whose default another command took since asks Replace first, as a recording does. `taken`: the defaults going back. */
export function ResetAsk({ t, id, bindings, ask, titleOf, onReplace, onCancel }: { t: T; id: string; bindings: Bindings; ask: { clash: string[]; taken: string[] }; titleOf: (id: string) => string; onReplace: () => void; onCancel: () => void }) {
  const first = ask.taken.find((b) => conflicts(bindings, b, id).some((c) => ask.clash.includes(c)));
  return (
    <div className="conflict" role="alert">
      <span aria-hidden>⚠ </span>
      {t('settings.kbd.usedBy', { keys: keysText(first ?? '', bindings), title: ask.clash.map(titleOf).join(', ') })}{' '}
      <button className="btn p" onClick={onReplace}>
        {t('settings.keys.replace')}
      </button>{' '}
      <button className="btn" onClick={onCancel}>
        {t('settings.keys.cancel')}
      </button>
    </div>
  );
}
