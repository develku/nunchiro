// V2-8e (HIDEROWS r6): the decision line under the session row that asked (or under the project header for a
// project-level item), its icon buttons and the compact peek. Keys 1, 2, 3, Space and Enter act only while the session's
// block has focus; they are never printed, the tooltips say them. Risk comes from the core (`isRisky`, fail-closed).
import { PLAIN } from '../plainText';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Answer } from '../queue/answer';
import { answered, DENY_NOTE_MAX, whoOf } from '../queue/answer';
import { kindKey, type Session } from '../types';
import { asks, isRisky, rowPlan, stateLine, whatWhy, type Item, type Line } from './decisions';
import { Icon } from '../icons/Icon';
import { plain } from '../chat/pending';
import { ErrorLine } from '../errors';
import { makeT, type Key } from '../i18n'; // V2-14f

export type T = (key: Key, args?: Record<string, string | number>) => string;
export const tEn: T = makeT('en', 'en');

/** Sends one answer for an item; null when this window already sent one for it. */
/** `confirmed`: only the panel card's focus-then-Enter allow of a risky item sets it. */
export type OnAnswer = (d: Item, a: Answer, confirmed?: boolean) => Promise<unknown> | null;

const ICON: Record<'check' | 'info' | 'x' | 'eye', ReactNode> = {
  check: <path d="M4 12.5l5 5L20 6.5" strokeWidth="2.4" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.6h.01" strokeWidth="2.6" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6L6 18" strokeWidth="2.4" />,
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};
const Svg = ({ k }: { k: keyof typeof ICON }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {ICON[k]}
  </svg>
);
function IconButton({ k, tip, cls = '', act, onClick, disabled }: { k: keyof typeof ICON; tip: string; cls?: string; act: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`qib ${cls}`} data-act={act} data-tip={tip} aria-label={tip} disabled={disabled} onClick={(e) => (e.stopPropagation(), onClick())}>
      <Svg k={k} />
    </button>
  );
}

// One peek at a time across the tree.
let closePeek: (() => void) | null = null;

interface Props {
  line: Line;
  session?: Session;
  /** Under the project header (no session row of its own): the line is its own focus stop and shows the count. */
  head?: boolean;
  /** Beneath a folded project/group: details only; answers stay in the panel (needs 128). */
  folded?: boolean;
  onAnswer: OnAnswer;
  /** Jump to the session's panel and its decision card. */
  onDetails: (d: Item) => void;
  /** V2-14f: the window's catalogue lookup; English when the caller passes none. */
  t?: T;
}

/** A session row and its decision line in one block: number keys, Space and Enter act only while focus is inside it.
 * `row` draws the session row; its click is `details` (the jump to the panel). */
export function DecisionRow(p: Props & { row?: (details: () => void) => ReactNode }) {
  const { node, keys, details } = useDecisionLine(p);
  if (p.head) return <div className="sess hl">{node}</div>;
  return (
    <div className="sess" onKeyDown={keys}>
      {p.row?.(details)}
      {node}
    </div>
  );
}

function useDecisionLine({ line, session, head, folded, onAnswer, onDetails, t = tEn }: Props) {
  // Q9 pop-J22-1: a background note or stale flag beside a real ask is no second item: the row answers the ask.
  const shown = asks(line.items).length ? asks(line.items) : line.items;
  const first = shown[0];
  const full = rowPlan(shown, session, t);
  // A9 (ticket 991): a terminal dialog's one answer is Esc, which for Claude's folder trust means "No, exit". The row has no
  // room for those words, so it offers no bare X for it; the panel card names it ("Esc: No, exit").
  const plan = first.kind === 'dialog' ? { ...full, deny: undefined } : full;
  const risky = line.items.some(isRisky);
  // Look 1117 v14 N14-S3-4: a line of background tasks only ("task running") is not the user's turn: the working tone.
  const note = line.items.every((d) => d.kind === 'background');
  const [denying, setDenying] = useState(false);
  const [peek, setPeek] = useState(false);
  const [, setSent] = useState(0);
  const [err, setErr] = useState<unknown>(null);
  const block = useRef<HTMLDivElement>(null);
  const done = line.answered || line.items.every((d) => answered(d.id));
  // A question that wraps to two lines keeps that height once answered, so answering moves no row (needs 49).
  const held = useRef(0);
  useLayoutEffect(() => {
    if (!done && block.current) held.current = block.current.offsetHeight;
  });
  const send = (a: Answer) => {
    const p = onAnswer(first, a);
    if (!p) return;
    setSent((n) => n + 1);
    setErr(null);
    p.then(
      () => setSent((n) => n + 1),
      (e: Error) => (setErr(e), setSent((n) => n + 1)),
    );
  };
  const allow = () => plan.allow && !done && send(plan.allow.answer);
  // Deny opens the one-line instruction when the core takes one; otherwise it denies at once.
  const deny = () => {
    if (!plan.deny || plan.choose.length || done) return;
    if (first.deny_note) setDenying(true);
    else send(plan.deny.answer);
  };
  // The details target is the first real ask: a stale flag listed before it must not hide it.
  const details = () => (setPeek(false), onDetails(asks(line.items)[0] ?? first));
  const togglePeek = () => setPeek((p) => !p);
  const focusRow = () => block.current?.closest('.sess')?.querySelector<HTMLElement>('.row.wt2, .q[tabindex]')?.focus();

  const keys = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, .peek, .dn')) return;
    const onRow = t.matches('.row.wt2, .q[tabindex]');
    if (folded) {
      if (e.key === 'Enter' && onRow) e.preventDefault(), details();
      return;
    }
    if (e.code === 'Space' && onRow) return e.preventDefault(), togglePeek();
    if (e.key === 'Enter' && onRow) return e.preventDefault(), details();
    if (e.code === 'Digit1') return e.preventDefault(), allow();
    if (e.code === 'Digit2') return e.preventDefault(), details();
    if (e.code === 'Digit3') return e.preventDefault(), deny();
  };

  const count = shown.length;
  // V2.5-82: agent text for the eye only; the answer and the risky rule read the raw item.
  const what = plain(stateLine(first, t)); // B20: a state phrase, not a cut of the screen
  // Under the header there is no session row naming who asks: the line names it (a board item, its source).
  // N25 (look 1117 v3): a manual board card's source is no word for a user ("board"): its line is its own question.
  // A merge card's line keeps its board card but is the lead's ask: the lead names it (look v15 B).
  const who = session ? whoOf(session) : first.board ? (first.board.source_name ?? '') : t('decisions.someSession');
  // HIDEROWS r6: the small red Caution text label, the only red on a risky row (needs 92: the row stays orange). Under a
  // project head it sits before the name, outside the question, which the name squeezes first; on a session's own line
  // it leads the question.
  const caution = risky && !done && (
    <b className="warn" title={t('decisions.caution')}>
      {t('decisions.caution')}
    </b>
  );
  const node = (
    <>
      <div
        ref={block}
        className={`q${done ? ' answered' : ''}${risky ? ' risky' : ''}${note ? ' note' : ''}`}
        data-hint-skip // ticket 389: its session row has the label; the hover buttons are hidden until then
        data-line={line.key}
        data-item={first.id}
        data-risky={risky || undefined}
        style={done && held.current ? { minHeight: held.current } : undefined}
        tabIndex={head ? 0 : undefined}
        role={head ? 'group' : undefined}
        aria-label={head ? (!who ? what : done ? t('decisions.answeredWho', { who }) : t('decisions.lineLabel', { who, kind: t(kindKey[first.kind]), detail: count > 1 ? t('decisions.waiting', { count }) : what })) : undefined}
        onKeyDown={head ? keys : undefined}
        // A click on the line (not on one of its buttons) is the row's click: details.
        onClick={(e) => !(e.target as Element).closest('button, input, .menu') && details()}
      >
        {head && caution}
        {head && who && <span className="who">{who}</span>}
        {head && count > 1 && <span className="two">{count}</span>}
        <span className="qt" title={plain(first.text)}>
          {/* hiderows-r6 puts the chip inside the question's own span: beside it the chip and the button left the
              question 17 px of a 249 px sidebar and cut it to "npm…" (needs 130, gap 4). */}
          {!head && caution}
          {/* A space keeps the label and the question apart for a screen reader too. */}
          {!head && caution && ' '}
          {line.changed ? t('decisions.changed') : done ? t('decisions.answered') : count > 1 ? t('decisions.more', { what, more: count - 1 }) : what}
        </span>
        {/* FIDELITY BAR (needs 130): an icon, as ko/v2-8a-a-folds ② draws it. The words of a text button took most of
            the line and pushed the question into an ellipsis; they stay in the tooltip and the accessible name. */}
        {!done && folded && <IconButton k="info" act="details" tip={t('decisions.openInPanel')} onClick={details} />}
        {!done && !folded && (
          <span className="ag">
            {plan.allow && <IconButton k="check" cls="al" act="allow" tip={t('decisions.allowTip')} onClick={allow} />}
            {plan.choose.length > 0 && <Choose acts={plan.choose} onPick={(a) => send(a.answer)} t={t} />}
            <IconButton k="info" act="details" tip={t('decisions.detailsTip')} onClick={details} />
            {plan.deny && !plan.choose.length && <IconButton k="x" cls="no" act="deny" tip={t('decisions.denyTip')} onClick={deny} />}
            <IconButton k="eye" cls="eye" act="peek" tip={t('decisions.peekTip')} onClick={togglePeek} />
          </span>
        )}
      </div>
      <ErrorLine t={t} error={err} className="qerr" />
      {denying && !done && !folded && <DenyNote onSend={(text) => (setDenying(false), send(text ? { type: 'deny_with', text } : { type: 'deny' }))} onCancel={() => (setDenying(false), focusRow())} t={t} />}
      {peek && !done && !folded && (
        <Peek
          anchor={block}
          item={first}
          count={count}
          allow={plan.allow ? allow : undefined}
          deny={plan.deny && !plan.choose.length && !risky && count === 1 ? () => plan.deny && send(plan.deny.answer) : undefined}
          details={details}
          onClose={() => (setPeek(false), focusRow())}
          t={t}
        />
      )}
    </>
  );
  return { node, keys, details };
}

function Choose({ acts, onPick, t }: { acts: { label: string; answer: Answer }[]; onPick: (a: { answer: Answer }) => void; t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="dd">
      <button type="button" className="b y" data-act="choose" aria-expanded={open} aria-haspopup="menu" onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}>
        {t('decisions.choose')} <Icon name="triangle-down" size={12} />
      </button>
      {open && (
        <span className="menu glass" role="menu">
          {acts.map((a) => (
            <button key={a.label} type="button" role="menuitem" onClick={(e) => (e.stopPropagation(), setOpen(false), onPick(a))}>
              {plain(a.label)}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** The row's deny: an optional one-line instruction; Enter sends, Esc cancels, empty sends a plain deny. */
function DenyNote({ onSend, onCancel, t }: { onSend: (text: string) => void; onCancel: () => void; t: T }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="dn">
      <input {...PLAIN}
        ref={input}
        value={text}
        maxLength={DENY_NOTE_MAX}
        placeholder={t('decisions.denyNotePh')}
        aria-label={t('decisions.denyNoteLabel')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') e.preventDefault(), onSend(text.trim());
          if (e.key === 'Escape') e.preventDefault(), onCancel();
        }}
      />
      <button type="button" className="b y" data-act="deny-send" disabled={!text.trim()} onClick={() => onSend(text.trim())}>
        {t('decisions.send')}
      </button>
      <button type="button" className="b" data-act="deny-plain" onClick={() => onSend('')}>
        {t('decisions.justDeny')}
      </button>
    </div>
  );
}

/** The compact peek (about 260 px): what, why, and allow and deny when the row may send them; else Open in panel. */
function Peek({ anchor, item, count, allow, deny, details, onClose, t }: { anchor: React.RefObject<HTMLDivElement | null>; item: Item; count: number; allow?: () => void; deny?: () => void; details: () => void; onClose: () => void; t: T }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const ww = whatWhy(item, t);
  const [what, why] = [plain(ww.what), plain(ww.why)];
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const side = anchor.current?.closest('aside')?.getBoundingClientRect();
    if (a) setAt({ left: (side?.right ?? a.right) + 8, top: Math.max(4, Math.min(a.top - 4, window.innerHeight - 140)) });
  }, [anchor]);
  useEffect(() => {
    closePeek?.();
    closePeek = onClose;
    return () => void (closePeek === onClose && (closePeek = null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Focus moves to the peek itself once it is placed (a hidden box takes no focus; a focused button would show its
  // tooltip, which takes the first Esc); Esc and Space close it and give focus back, Tab reaches its buttons.
  useEffect(() => void (at && box.current?.focus()), [at]);
  return (
    <div
      ref={box}
      className="peek glass light-you light-edge" // ticket 1041: glass, its orange edge is the warm light
      tabIndex={-1}
      role="dialog"
      aria-label={t('decisions.peekLabel', { what })}
      style={at ? { left: at.left, top: at.top } : { visibility: 'hidden' }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        e.stopPropagation();
        if (e.key === 'Escape' || e.code === 'Space') return e.preventDefault(), onClose();
        if (e.code === 'Digit1' && allow) return e.preventDefault(), allow();
        if (e.code === 'Digit2') return e.preventDefault(), details();
        if (e.code === 'Digit3' && deny) return e.preventDefault(), deny();
      }}
    >
      <code title={plain(item.text)}>{count > 1 ? t('decisions.more', { what, more: count - 1 }) : what}</code>
      <p className="why2">{why}</p>
      <div className="ag">
        {/* No allow here (risky, a choice, several pending): the panel allows it. */}
        {!allow && (
          <button type="button" className="b y" data-act="details" onClick={details}>
            {t('decisions.openInPanel')}
          </button>
        )}
        {allow && <IconButton k="check" cls="al" act="allow" tip={t('decisions.allowTip')} onClick={allow} />}
        {deny && <IconButton k="x" cls="no" act="deny" tip={t('decisions.denyTip')} onClick={deny} />}
      </div>
    </div>
  );
}
