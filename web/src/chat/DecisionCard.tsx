// V2-8e (HIDEROWS r6, amended by DECISIONW): one session's decision card, hosted by the Decisions widget
// (decisions/DecisionsWidget.tsx). 1 allows and 3 deny; a risky permission allows only by focus then Enter (never a
// click or key 1); "Allow for this session" is mouse only and never offered on a risky one. Esc returns to the place a jump came from. Several
// items are listed one by one: there is no allow-all. `hosted` drops the breadcrumb and the card's own title (the
// widget header and the group header name the place); the answer, risky and focus logic is the same either way.
import { PLAIN } from '../plainText';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { answered, DENY_NOTE_MAX, dropDenyNote, setDenyNote, takesText, whoOf, withNote, type Answer } from '../queue/answer';
import { asks, isRisky, optionRows, rowPlan, whatWhy, type Item } from '../tree/decisions';
import { tEn, type OnAnswer, type T } from '../tree/DecisionLine';
import type { Session } from '../types';
import { openSession } from '../tree';
import { show as paneShow } from '../pane/store';
import { pendingEdit, Pending, plain, sessionPath } from './pending';
import { Diff, Open } from './Rows';
import './decision-card.css';
import { ErrorLine } from '../errors';
import { questionRest, readable, toolOf } from '../decisions/readable';
import { keyText } from '../keys';

interface Props {
  session: Session;
  /** The session the jump came from (the breadcrumb's target); null when there is none to go back to. */
  from?: { id: string; name: string } | null;
  onAnswer: OnAnswer;
  onBack: () => void;
  /** Hosted in the Decisions widget: no breadcrumb, a group header with the age; an answer does not navigate. */
  hosted?: { age: string; place?: string };
  /** Hosted: a changing number asks this card to take focus (a jump from a decision row). Unhosted, it always does. */
  focusAsk?: number;
  /** Hosted: the ask was used (focus moved once); the host drops it so a later mount or item never takes focus. */
  onFocused?: () => void;
  /** Hosted: an answer was sent (the host ends the jump; nothing navigates). */
  onAnswered?: () => void;
  /** V2-14f: the window's catalogue lookup; English when the caller passes none. */
  t?: T;
  /** Ticket 1030: docked above the session's own composer: no header, never takes focus by itself (Shift+Tab from the
   *  composer reaches it), an answer does not navigate. */
  docked?: boolean;
  /** Ticket 1030: one quiet line under the items ("Also in Decisions until answered."). */
  note?: string;
}

/** The first item's first safe action: on a risky one its deny (allow needs a deliberate focus). */
export function focusCard(root: Element | null | undefined) {
  const first = root?.querySelector<HTMLElement>('.dc-item');
  const pick = (sel: string) => first?.querySelector<HTMLElement>(sel);
  const el = first?.classList.contains('risky') ? pick('[data-act="deny"]') : (pick('[data-act="allow"]') ?? pick('[data-act="choose"]') ?? pick('[data-act="terminal"]') ?? pick('[data-act="deny"]'));
  el?.focus();
  return !!el;
}

/** Ticket 1097: the button a digit typed into the empty composer presses on the docked card, by the focused card's key rule:
 *  a question's option n (the prompt's own number), an ordinary permission's Allow once (1) or Deny (3). Never a risky
 *  permission (focus then Enter) or a dialog (answered in the terminal); null leaves the digit as text. */
export function digitButton(card: Element | null | undefined, digit: string) {
  const item = card?.querySelector<HTMLElement>('.dc-item');
  if (!item || !/^[1-9]$/.test(digit) || item.classList.contains('risky')) return null;
  const sel = item.dataset.kind === 'question' ? `[data-act="choose"][data-n="${digit}"]` : item.dataset.kind === 'permission' ? { 1: '[data-act="allow"]', 3: '[data-act="deny"]' }[digit] : undefined;
  return sel ? item.querySelector<HTMLButtonElement>(`${sel}:not(:disabled)`) : null;
}

export function DecisionCard({ session, from = null, onAnswer, onBack, hosted, focusAsk, onFocused, onAnswered, t = tEn, docked, note }: Props) {
  const items = asks(session.pending) as Item[];
  const root = useRef<HTMLDivElement>(null);
  const focusFirst = () => focusCard(root.current);
  // Ticket 70: a re-filed prompt (a terminal refit redraws it under a new item id) replaces the item's buttons and drops
  // their focus. Remember which button of which item the card held, and give the same `data-act` on the new item
  // the focus. Focus only: nothing is sent and no answer, risky or key rule changes.
  const held = useRef<{ act: string; item: string } | null>(null);
  // Ticket 991 B13: a re-filed prompt (same kind and text, a new id) keeps the deny instruction typed for it.
  const notes = useRef(new Map<string, string>());
  // Ticket 991 B3: a refusal shows at once next to the buttons, also when the prompt was re-filed while the answer was on
  // its way (the item it was for is gone, its card with it).
  const [errs, setErrs] = useState<Record<string, unknown>>({});
  const seen = useRef<{ id: string; kind: string; risky: boolean; text: string }[]>([]);
  const ids = items.map((d) => d.id).join('\n');
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = items.map((d) => ({ id: d.id, kind: d.kind, risky: isRisky(d), text: asked(d) }));
    const was = held.current;
    if (!was) return;
    const old = before.find((x) => x.id === was.item);
    // Only when that item was replaced (not answered) and focus has fallen to the page, never from another field.
    if (!old || items.some((d) => d.id === old.id) || answered(old.id)) return;
    const active = document.activeElement;
    if (active && active !== document.body && !root.current?.contains(active)) return;
    // The same prompt (kind, risk and what it asks, whitespace aside): a re-filed prompt keeps the focus, but another decision
    // never inherits it, or one Enter would answer something the user did not read (and a safe button never hands its focus
    // to a risky allow, which Enter confirms).
    const fresh = items.filter((d) => d.kind === old.kind && isRisky(d) === old.risky && asked(d) === old.text && !before.some((x) => x.id === d.id));
    for (const d of fresh) {
      const btn = [...(root.current?.querySelectorAll<HTMLElement>('.dc-item') ?? [])].find((e) => e.dataset.item === d.id)?.querySelector<HTMLElement>(`[data-act="${was.act}"]:not(:disabled)`);
      if (btn) return btn.focus();
    }
  }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = !docked && (!hosted || focusAsk !== undefined);
  useEffect(() => {
    if (!ask) return;
    // The first item's first safe action takes focus: on a risky one its deny (allow needs a deliberate focus). After
    // the frame, so the move the jump makes (which focuses its pane) comes first.
    const t = setTimeout(() => (focusFirst(), hosted && onFocused?.()), 0);
    return () => clearTimeout(t);
  }, [session.id, focusAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return null;
  const name = hosted?.place ? `${whoOf(session)} · ${hosted.place}` : whoOf(session); // look 1117 v10 Home S3-2: "Lead" of which project
  return (
    <div
      ref={root}
      className={`deccard${hosted ? ' hosted' : ''}${docked ? ' docked' : ''}`} /* docked: the warm ring of the design book's card (decision-card.css) */
      data-session={session.id}
      role="region"
      aria-label={items.length === 1 ? t('decisions.cardOne', { name }) : t('decisions.cardMany', { name, count: items.length })}
      onFocusCapture={(e) => {
        const t = e.target as HTMLElement;
        const item = t.closest<HTMLElement>('.dc-item')?.dataset.item;
        held.current = t.dataset.act && item ? { act: t.dataset.act, item } : null;
      }}
      // A removed button sends no blur, so the memory survives a re-file; a blur to the page or another field clears it.
      onBlurCapture={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to ? !e.currentTarget.contains(to) : (e.target as Node).isConnected) held.current = null;
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Escape') return e.preventDefault(), onBack();
      }}
    >
      {from && (
        <button type="button" className="dc-back" onClick={onBack}>
          {t('decisions.back', { name: from.name, key: keyText('decision.back') })}
        </button>
      )}
      {docked ? null : hosted ? (
        <div className="dwh">
          <b>{name}</b>
          <span className="tm">{hosted.age}</span>
        </div>
      ) : (
        <h4>
          {name} · {items.length === 1 ? kindTitle(items[0], t) : t('decisions.waiting', { count: items.length })}
        </h4>
      )}
      {items.map((d) => (
        <CardItem key={d.id} d={d} session={session} onAnswer={onAnswer} onDone={docked ? () => {} : hosted ? (onAnswered ?? (() => {})) : onBack} t={t} docked={docked} notes={notes.current} err={errs[keyOf(d, t)]} onErr={(k, e) => setErrs((m) => ({ ...m, [k]: e }))} />
      ))}
      {items.length > 1 && <p className="dc-hint">{t('decisions.oneAtATime')}</p>}
      {note && <p className="dc-hint dc-also">{note}</p>}
    </div>
  );
}

/** Ticket 991 B3/B13: one prompt across re-files (a terminal refit rewraps it under a new id): its kind and its one line
 *  (the command, "Edit app.py", the question). Its typed deny instruction and its last refusal stay with it. */
const keyOf = (d: Item, t: T) => {
  const r = readable(d, t);
  // The whole path too: the same file name in two folders is two prompts.
  return `${d.kind}:${(r?.what || whatWhy(d, t).what).replace(/\s+/g, ' ').trim()}:${r?.path ?? ''}`;
};

const NONE = new Map();
/** A hook item's Edit/Write/MultiEdit input as the chat's pending edit card reads it; null for anything else. */
const proposedEdit = (d: Item) => {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(d.text);
  } catch {
    return null;
  }
  const name = typeof v?.content === 'string' ? 'Write' : Array.isArray(v?.edits) ? 'MultiEdit' : 'old_string' in (v ?? {}) ? 'Edit' : '';
  const edit = name ? pendingEdit({ kind: 'tool_use', tool_id: d.id, name, input: v }) : null;
  // w108 review M1: replace_all changes every place the old text appears, more than the lines show (readable.ts says it too).
  const every = [v, ...(Array.isArray(v?.edits) ? v.edits : [])].some((e) => (e as Record<string, unknown> | null)?.replace_all === true);
  return edit && { ...edit, every };
};

/** What the item asks, with the whitespace a terminal refit rewraps ignored. */
const asked = (d: Item) => d.text.trim().replace(/\s+/g, ' ');

export const kindTitle = (d: Item, t: T) => (d.kind === 'question' ? t('decisions.kindQuestion') : d.kind === 'dialog' ? t('decisions.kindDialog') : isRisky(d) ? t('decisions.kindRisky') : t('decisions.kindPermission'));

/** Real-app 11-10 defect 5: what Esc, the one key a dialog takes from the window (needs 44), does to it: the prompt's own "No"
 *  option when it lists one, else for a folder-trust prompt the agent exits (Claude's says "Esc to exit"), else its own cancel. */
const escEffect = (d: Item, t: T) => d.choices.find((c) => /^no\b/i.test(c.label.trim()))?.label.trim() ?? (/\btrust\b/i.test(d.text) ? t('decisions.escExits') : t('decisions.escCancels'));

/** Shows the session (its tab) with its terminal focused: a dialog is answered there. */
const toTerminal = (session: Session) => {
  openSession(session.id);
  paneShow(session.id, 'pty', true);
};

function CardItem({ d, session, onAnswer, onDone, t, notes, err, onErr, docked }: { d: Item; session: Session; onAnswer: OnAnswer; onDone: () => void; t: T; notes: Map<string, string>; err: unknown; onErr: (key: string, e: unknown) => void; docked?: boolean }) {
  const plan = rowPlan([d], session, t);
  // Ticket 294 item 3: every option of the prompt is a button in its order; those the window never sends are disabled.
  const opts = optionRows(d, plan);
  // Home look S2-7: the question's "Type something." is answered on this card (its own box below).
  const typeAt = d.kind === 'question' && !plan.note ? d.choices.findIndex((c) => takesText(c.label)) : -1;
  const stuck = d.kind === 'question' && opts.some((o) => !o.act && !(typeAt >= 0 && o.label === d.choices[typeAt].label));
  const optWhy = useId(); // Ticket 412: a disabled control names its reason to screen readers too (aria-describedby to a hidden span), not only in its tooltip.
  // Home look S2-7: the question's "Type something." opens a box here; its words go as that choice's answer.
  const [words, setWords] = useState<string | null>(null);
  const optButton = (o: (typeof opts)[number], first: boolean) =>
    typeAt >= 0 && o.label === d.choices[typeAt].label ? (
      <button key={`${o.n}:${o.label}`} type="button" className="b" data-act="type" data-n={o.n} disabled={done} aria-expanded={words !== null} onClick={() => setWords((w) => (w === null ? '' : w))}>
        {o.n} {plain(o.label)}
      </button>
    ) : o.act ? (
      <button key={`${o.n}:${o.label}`} type="button" className={`b${first ? ' y' : ''}`} data-act="choose" data-n={o.n} disabled={done} onClick={() => send(o.act!.answer)}>
        {plain(o.act.label)}
      </button>
    ) : (
      // Ticket 991 B4: an option the window never sends is text, not a button that does nothing.
      <span key={`${o.n}:${o.label}`} className="opt" data-act="option" data-n={o.n} title={t('decisions.optionTerminal')} aria-describedby={optWhy}>
        {o.n} {plain(o.label)}
      </span>
    );
  const risky = isRisky(d);
  const noteKey = keyOf(d, t);
  const [note, setNoteState] = useState(() => notes.get(noteKey) ?? '');
  const setNote = (v: string) => (notes.set(noteKey, v), setNoteState(v));
  // Look 1117 v13 N12-S2-3: any Deny of this item carries the words (the chat card's too), also after a re-file's new id.
  // The docked card has no field: it never clears words typed in Decisions (Fable w105 NOTE 5).
  useEffect(() => {
    if (docked) return;
    setDenyNote(d.id, note);
    return () => dropDenyNote(d.id, note);
  }, [d.id, note, docked]);
  const [hint, setHint] = useState(false);
  const [, setSent] = useState(0);
  const { what: rowWhat, why: asksWhy } = whatWhy(d, t);
  // Ticket 991 B4/B7: the request in words ("Edit app.py", the command, the question) and its own text, not the JSON or the
  // whole screen.
  const shown = readable(d, t);
  const what = shown?.what || rowWhat;
  const body = shown?.body ?? d.text;
  // Real-app 11-10 defect 5: a dialog (an agent's folder-trust prompt) is answered in the terminal, never "before it runs this".
  const dialog = d.kind === 'dialog';
  // A risky item read only from the screen is risky because the core could not match it to the agent's request.
  const screenOnly = risky && !d.text.trimStart().startsWith('{');
  const why = dialog ? t('decisions.dialogWhy') : screenOnly ? t('decisions.whyScreen') : asksWhy;
  const done = answered(d.id);
  const send = (a: Answer, confirmed = false) => {
    const p = onAnswer(d, a, confirmed);
    if (!p) return;
    onErr(noteKey, null);
    setSent((n) => n + 1);
    p.then(onDone, (e: Error) => (onErr(noteKey, e), setSent((n) => n + 1)));
  };
  // Ticket 1030 (permcard-1121): docked, the card is one row and Deny answers at once (look v34 S3-4); what to do instead
  // goes in the composer, held until the answer. Decisions keeps its instruction field.
  const noteable = !!(plan.deny && d.deny_note && d.kind === 'permission' && !plan.note && !docked);
  // Look v34 S3-4: docked, the deny goes as deny_with (words typed for this item elsewhere, else none), so the core stops
  // Claude's turn as for one with words and the next composer message reaches it at once.
  const dockedDeny = (a: Answer): Answer => (a.type === 'deny' ? { type: 'deny_with', text: '' } : a);
  const deny = () =>
    plan.deny &&
    send(note.trim() && d.deny_note && d.kind === 'permission' ? { type: 'deny_with', text: note.trim() } : docked && d.deny_note && d.kind === 'permission' ? dockedDeny(withNote(d.id, plan.deny.answer)) : plan.deny.answer);
  const named = docked && d.kind === 'permission' ? toolOf(d, what) : null;
  // Look v35 b S3-1 (inventory 3.4.1/3.4.6): a pending Edit/Write/MultiEdit shows its diff on the docked card, path project-relative.
  const edit = named && named.tool !== 'Bash' ? proposedEdit(d) : null;
  // w108 review S1: the diff's "Show all N lines" works here too (the card sits outside the chat's Open provider).
  const [shownAll, setShownAll] = useState(false);
  const all = { has: (k: string) => k.endsWith(':all') && shownAll, toggle: () => setShownAll((x) => !x) };
  const arg = edit ? (sessionPath(named!.arg, session.cwd) ?? named!.arg) : named?.arg;
  // The risky allow is the plain allow once, sent only by Enter on the focused button.
  const allowOnce = risky && d.kind === 'permission' && !plan.note ? ({ type: 'allow_once' } as Answer) : plan.allow?.answer;
  return (
    <div
      className={`dc-item${risky ? ' risky' : ''}`}
      data-item={d.id}
      data-kind={d.kind}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || t.closest('input')) return;
        if (e.code === 'Digit1' && plan.allow) return e.preventDefault(), send(plan.allow.answer);
        if (e.code === 'Digit3' && plan.deny && d.kind !== 'question') return e.preventDefault(), deny();
        const n = /^Digit([1-9])$/.exec(e.code);
        // The digit is the prompt's own number, so an option the window does not send never shifts the others.
        const pick = n && d.kind === 'question' ? opts.find((o) => o.n === n[1])?.act : undefined;
        if (pick) return e.preventDefault(), send(pick.answer);
      }}
    >
      <p className="dc-what">
        {risky && <b className="warn">{t('decisions.caution')}</b>}
        {/* Ticket 1130 S1: an outward call (mail, a calendar event, a post, a publish) says which, in every session. */}
        {d.outward && <b className="dc-outward"> {t(`decisions.outward.${d.outward}` as const)}</b>}
        {/* Sixth look (B6-S3-3): a question is its own line ("What alpha or beta?" read as one sentence). */}
        {named ? (
          <>
            {' '}<span className="dc-tool">{named.tool}</span> <span className="dot">·</span> <code>{plain(arg ?? '')}</code>
          </>
        ) : (
          <>
            {d.kind !== 'question' && !docked && <b>{t('decisions.what')}</b>} {plain(what)}
          </>
        )}
      </p>
      <p className="dc-why">
        {!docked && <b>{t('decisions.why')}</b>} {plain(why)}
      </p>
      {edit && (
        <Pending.Provider value={{ session, boot: null, matched: NONE }}>
          {edit.every && <p className="dc-why dc-every">{t('decisions.everyPlace')}</p>}
          <Open.Provider value={all}>
            <Diff row={{ kind: 'diff', key: 0, edit }} bare />
          </Open.Provider>
        </Pending.Provider>
      )}
      {/* The whole request, scrollable: a focus stop so a keyboard can scroll it. Shown through `plain` (V2.5-82); the
          answer, the risky rule and `asked()` read the raw item. */}
      {!docked && body.trim() && body.trim() !== what.trim() && (d.kind !== 'question' || questionRest(body, what, d.choices.map((c) => c.label))) && (
        <code className="dc-code" tabIndex={0} aria-label={t('decisions.fullRequest')}>
          {plain(body)}
        </code>
      )}
      {/* V2.5-49: `plain` removed something the owner cannot see; say so (the effect, never the characters). A line break
          `plain` only normalises is not a removal. Every field `plain` cleans on this card counts: the request, what, why,
          the choice labels and the always-allow option. Plain text: no handler. */}
      {[body, what, why, d.allow_always, d.allow_scope, ...opts.map((o) => o.act?.label ?? o.label)].some((x) => x != null && plain(x) !== x.replace(/\r\n?/g, '\n')) && <p className="dc-hint dc-hidden">{t('decisions.hiddenRemoved')}</p>}
      {plan.note ? (
        <p className="dc-hint">{plan.note}</p>
      ) : (
        <div className="dc-btns">
          {d.kind === 'question' && opts.map((o) => optButton(o, o === opts.find((x) => x.act)))}
          {dialog && (
            <button type="button" className="b y" data-act="terminal" title={t('decisions.openTerminalTip')} onClick={() => toTerminal(session)}>
              {t('decisions.openTerminal')}
            </button>
          )}
          {d.kind !== 'question' && allowOnce && !risky && (
            <button type="button" className="b y" data-act="allow" disabled={done} title={t('decisions.allowTip')} onClick={() => send(allowOnce)}>
              {docked ? t('decisions.allowOnce') : t('decisions.allow')}
              {docked && <kbd className="k">1</kbd>}
            </button>
          )}
          {/* A risky card leads with deny (mockup r6); its allow follows, by focus then Enter. */}
          {plan.deny && risky && (
            <button type="button" className="b d" data-act="deny" disabled={done} title={d.kind === 'question' ? t('decisions.cancel') : t('decisions.denyTip')} onClick={deny}>
              {d.kind === 'question' ? t('decisions.cancel') : t('decisions.deny')}
              {docked && d.kind !== 'question' && <kbd className="k">3</kbd>}
            </button>
          )}
          {d.kind !== 'question' && allowOnce && risky && (
            <button
              type="button"
              className="b r risky"
              data-act="allow"
              disabled={done}
              title={t('decisions.riskyAllowTip')}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                e.stopPropagation();
                // The one confirmed allow: the core refuses an unconfirmed allow of a risky item.
                send(allowOnce, true);
              }}
              // A click (mouse, touch or Space) never allows a risky request: it focuses and says how.
              onClick={(e) => (e.preventDefault(), e.currentTarget.focus(), setHint(true))}
            >
              {docked ? (
                <>
                  {t('decisions.allow')}
                  <kbd className="k">{t('decisions.focusEnter')}</kbd>
                </>
              ) : (
                t('decisions.riskyAllow')
              )}
            </button>
          )}
          {plan.deny && !risky && (
            <button type="button" className="b d" data-act="deny" disabled={done} title={d.kind === 'question' ? t('decisions.cancel') : dialog ? t('decisions.dialogEscTip') : t('decisions.denyTip')} onClick={deny}>
              {d.kind === 'question' ? t('decisions.cancel') : dialog ? t('decisions.dialogEsc', { effect: plain(escEffect(d, t)) }) : t('decisions.deny')}
              {docked && !dialog && d.kind !== 'question' && <kbd className="k">3</kbd>}
            </button>
          )}
          {d.allow_always && !risky && (
            <button
              type="button"
              className="b"
              data-act="allow-always"
              tabIndex={-1}
              disabled={done}
              title={t('decisions.alwaysTip', { option: plain(d.allow_always) })}
              // Mouse only (permcard-1121): a keyboard press (detail 0) does nothing, and no key sends it.
              onClick={(e) => e.detail > 0 && send({ type: 'allow_always' })}
            >
              {/* Ticket 1030: it names what it adds (the exact command), as the core checked the agent's suggestion. */}
              {t('decisions.always')}
              {d.allow_scope && `: ${plain(d.allow_scope)}`}
            </button>
          )}
        </div>
      )}
      {/* Look v34: a permission's own options (they persist to the agent's config, v1a-03) are not listed: text chips read as
          buttons. The card offers Allow once, the session allow when the core built one, and Deny. */}
      {stuck && !dialog && <p className="dc-hint">{t('decisions.inTerminal')}</p>}
      {stuck && (
        <span id={optWhy} hidden>
          {t('decisions.optionTerminal')}
        </span>
      )}
      {typeAt >= 0 && words !== null && (
        <input {...PLAIN}
          className="dc-note"
          value={words}
          maxLength={DENY_NOTE_MAX}
          disabled={done}
          autoFocus
          aria-label={d.choices[typeAt].label}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && words.trim()) e.preventDefault(), send({ type: 'choose_with', index: typeAt, text: words.trim() });
          }}
        />
      )}
      {noteable && (
        <input
          {...PLAIN}
          className="dc-note"
          value={note}
          maxLength={DENY_NOTE_MAX}
          disabled={done}
          placeholder={t('decisions.denyNoteSentPh')}
          aria-label={t('decisions.denyNoteLabel')}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') e.preventDefault(), deny();
          }}
        />
      )}
      {hint && <p className="dc-hint">{t('decisions.clickHint')}</p>}
      <ErrorLine t={t} error={err} className="dc-hint err" />
    </div>
  );
}
