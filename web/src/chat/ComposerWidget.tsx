// Chat: the composer widget (split out of App.tsx, needs 183).
import { flushSync } from 'react-dom';
import { PLAIN } from '../plainText';
import { errorNote, notePlain, rawError, type Note } from '../errors';
import { CoreClient } from '../api';
import { hasTranscript } from './ChatView';
import { download } from '../terminal/save';
import { chordOf, composerKey, label, merge } from '../keys';
import { Icon } from '../icons/Icon';
import { sessionName } from '../Sidebar';
import { ChromeIcon } from '../chrome/icons';
import { ComposerMenu } from './ComposerMenu';
import { ComposerStash } from './ComposerStash';
import { getDraft, setDraft } from '../composer-drafts';
import { ContextRing, useSessionContext } from './ContextRing';
import { PlusMenu } from '../chrome/PlusMenu';
import { agentState, status, type Session } from '../types';
import { Picker } from '../picker/Picker';
import { PermChip } from './PermChip';
import { HandoffChip } from './HandoffChip';
import { openAgents } from '../settings/agents/open';
import { composerDrop, useImages } from '../images/attach';
import { ImageChips } from '../images/Chips';
import { useSideChats } from './useSideChats';
import { useComposerSend } from './useComposerSend';
import { asks, cardHeldRows, takeHeld, useHeld, useRefused } from './held';
import { restartable } from '../chrome/restart';
import { busyRow, takeRow, useQueue } from './queued';
import type { RefObject } from 'react';
import type { T } from '../i18n';
import { FOLLOWUP } from '../features/followup-default';
import { NightTidyCard } from '../bots/NightTidyCard';
import { DecisionCard, digitButton, focusCard } from './DecisionCard'; // ticket 1030
import { OutboxCard } from '../lead/OutboxCard';
import { alsoInDecisions, asks as waitingAsks, rowPlan, type Item } from '../tree/decisions';
import { answered, DENY_NOTE_MAX, takesText } from '../queue/answer';
import { plain as shown } from './pending';
import type { OnAnswer } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { useFeatureSetting } from '../settings/useFeatureSetting';
import { useEffect, useState } from 'react';
import { composerOffer } from '../features/pasted-server';
import { restartKeeping } from '../features/restart-keeping';
import { restartStart } from '../PermissionNeeded';
import { escaped, joinWords } from '../settings/agents/words';
import { AttachedChips, typingPing } from '../queue/Knock';
import { clearHomed, useHomed } from './draftHome';
import { noteWrite, takeWrite } from './nunchiroWrites';
import { useTeamNow } from '../lead/lead';

/** A pane terminal's selection goes to the composer as a quote; nothing is sent. */
export const insertQuote = (composer: RefObject<HTMLTextAreaElement | null>) => (text: string) => {
  const el = composer.current;
  if (!el) return;
  const quote = text.replace(/\s+$/, '').split('\n').map((l) => `> ${l}`).join('\n');
  el.value = el.value ? `${el.value.replace(/\n*$/, '')}\n${quote}\n` : `${quote}\n`;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
};

type Props = { first: boolean; pin?: string } & Pick<ReturnType<typeof useComposerSend>, 'pressRow' | 'send' | 'uncertainSend' | 'pendingEnter' | 'givenBack' | 'setGivenBack' | 'setDrafts' | 'drafts' | 'grow' | 'steerNow' | 'backgroundSend' | 'stopAgent'> &
  Pick<ReturnType<typeof useSideChats>, 'handoff' | 'setHandoff' | 'sideChats'> & {
    composerHidden: boolean;
    pinned: (pin: string) => Session | null;
    current: Session | null;
    termComposer: Record<string, boolean>;
    connected: boolean;
    images: ReturnType<typeof useImages>;
    t: T;
    core: CoreClient;
    setPaneNote: (note: Note) => void;
    bindings: ReturnType<typeof merge>;
    composer: RefObject<HTMLTextAreaElement | null>;
    closedText: { id: string; text: string } | null;
    run: (id: string) => void;
    placeText: (s: Session) => string;
    sessions: Session[];
    follow: (old: string, next: string, modelReplacement?: boolean) => void;
    resume: (s: Session) => void;
    resuming: boolean;
    /** Ticket 1030: the session in front, whose asks and Outbox cards show right above its composer (null: none). */
    front: string | null;
    onAnswer: OnAnswer;
    owner: Decision[];
  };

/** Ticket 1030: the floating card's height as `--dock-h`, so the output's last lines and its "new" chip stay clear of it.
 *  The dock is capped at 60% of the output above it (`--dock-max`): a tall card scrolls inside and never covers the tabs. */
const dockHeight = (el: HTMLDivElement | null) => {
  if (!el) return;
  const root = document.documentElement.style;
  const fit = () => {
    const out = document.querySelector('.chat:not([data-off]) .cscroll')?.getBoundingClientRect();
    const top = el.parentElement?.getBoundingClientRect().top;
    if (out && top !== undefined) el.style.setProperty('--dock-max', `${Math.max(120, Math.floor((top - out.top) * 0.6))}px`);
    root.setProperty('--dock-h', `${Math.ceil(el.offsetHeight)}px`);
  };
  const watch = new ResizeObserver(fit);
  watch.observe(el);
  window.addEventListener('resize', fit);
  return () => void (watch.disconnect(), window.removeEventListener('resize', fit), root.removeProperty('--dock-h'));
};

/** The composer of the focused session, or of a pinned one (`pin`). Its send path is useComposerSend's. */
export function ComposerWidget({ first, pin, composerHidden, pinned, current, termComposer, connected, images, pressRow, t, core, setPaneNote, bindings, handoff, setHandoff, sideChats, send, uncertainSend, pendingEnter, composer, givenBack, setGivenBack, setDrafts, drafts, grow, steerNow, backgroundSend, stopAgent, closedText, run, placeText, sessions, follow, resume, resuming, front, onAnswer, owner }: Props) {
  if (composerHidden) return null;
  const target = pin ? pinned(pin) : current;
  // A closed shell keeps its composer: Save to file and the temporary $EDITOR copy of its scrollback live in it. A composer the owner pinned stays.
  // A running shell shows its terminal, which takes the keys itself. Seventh look (A S3-2): any ended one (it exited, or its
  // run ended with the core, not only a closed one) shows the read-only line with Restart, as an ended agent's tab does.
  if (!pin && target && !hasTranscript(target) && agentState(target) === 'running' && !termComposer[target.id]) return null;
  const name = target ? sessionName(target) : pin;
  // v25-quiet-chat: the first message waiting for a startup dialog (held.ts); Cancel and Esc put the words back in the box.
  const held = useHeld(target?.id);
  const context = useSessionContext(core, target, !!target && target.id === current?.id, connected);
  const refused = useRefused(target?.id);
  const queued = useQueue(target?.id);
  const team = useTeamNow();
  const homed = useHomed(target?.id); // words that came home from the terminal (draftHome.ts)
  // ⌘Z (nunchiroWrites.ts): the line a take-back leaves, by session.
  const [undone, setUndone] = useState<{ id: string; text: string } | null>(null);
  const setBox = (box: HTMLTextAreaElement, value: string) => {
    if (!target) return;
    box.value = value;
    grow(box);
    setDrafts((d) => ({ ...d, [target.id]: !!value }));
    setDraft(target.id, value);
  };
  /** ⌘Z: Nunchiro's newest write into this box while the box still shows it, else a message of another sender in the agent's
   *  box (an empty composer only); false leaves the key to the textarea's own undo. */
  const undoWrite = (box: HTMLTextAreaElement) => {
    if (!target) return false;
    const w = takeWrite(target.id, box.value);
    if (w) {
      const id = target.id;
      const done = () => {
        setBox(box, w.before);
        clearHomed(id);
        setUndone(w.line ? { id, text: w.line } : null);
      };
      const asked = w.undo?.();
      // Words going back to the terminal leave the box only once the core put them there; refused, they stay.
      if (asked instanceof Promise) void asked.then(done, (e) => (noteWrite(id, w), setPaneNote(errorNote(notePlain(t, e), e))));
      else done();
      return true;
    }
    if (box.value || !target.take_back) return false;
    void core.request({ op: 'take_back', id: target.id }).catch((e) => setPaneNote(errorNote(notePlain(t, e), e)));
    return true;
  };
  /** Words coming back to the box go ahead of whatever it already holds. */
  const toBox = (box: HTMLTextAreaElement, text: string) => {
    if (!target) return;
    const before = box.value;
    box.value = box.value ? `${text}\n${box.value}` : text;
    noteWrite(target.id, { before, after: box.value }); // ⌘Z: words given back by a canceled send
    grow(box);
    setDrafts((d) => ({ ...d, [target.id]: true }));
    setDraft(target.id, box.value);
    box.focus();
  };
  const giveBackHeld = (box: HTMLTextAreaElement) => {
    const text = target && takeHeld(target.id);
    if (text) toBox(box, text);
  };
  // Held while a card waits (held.ts cardHeldRows); it goes in once the card is answered. Cancel takes it back, as the held first message.
  const { own: cardHeld, brief: briefHeld } = cardHeldRows((target as (Session & { send_log?: Parameters<typeof cardHeldRows>[0] }) | null)?.send_log);
  // The reply is async: the box may show another session's draft by then (Codex w23 MUST). The words go back to their
  // own session: into the box only while it still holds that session, else ahead of its saved draft.
  const cancelCardHeld = (box: HTMLTextAreaElement, row: (typeof cardHeld)[number]) => {
    if (!target) return;
    const id = target.id;
    return core.request({ op: 'cancel_send', id, send: row.id }).then(
      () => {
        if ((box.dataset.draftFor ?? id) === id) return toBox(box, row.content); // a box with no draftFor is not the shared one
        // shortcut: the saved draft is capped at 100,000 characters (composer-drafts.ts), so a held message and a draft
        // that together pass it lose the draft's end; needs a session switch inside the cancel round trip as well. Upgrade
        // to a second draft slot if a real report shows it.
        const kept = getDraft(id);
        setDraft(id, kept ? `${row.content}\n${kept}` : row.content);
        setDrafts((d) => ({ ...d, [id]: true }));
      },
      (e) => setPaneNote(errorNote(notePlain(t, e), e)),
    );
  };
  const stopShows = !!target && connected && agentState(target) === 'running' && status(target) === 'working'; // CHAT-STOP
  // Ticket 517: on Steer, Enter and the send-now chord trade places while the agent works; idle keys stay as they were.
  // Not for ACP agents and shells: the core refuses send-now for them (sessions.rs steer_now), so Enter queues as on Queue.
  const swap = useFeatureSetting(FOLLOWUP)[0] === 'steer' && stopShows && target.kind !== 'shell' && target.kind !== 'acp';
  // Enter steers only plain text: send carries images, a handoff and a retry (ticket 526: the hint must say the same).
  const plain = !!target && !images.of(target.id).length && (handoff?.fork?.id ?? handoff?.from) !== target.id && !pendingEnter[target.id];
  const rowAct = stopShows ? t('composer.steerNow') : t('composer.queue.send');
  // Ticket 1056: Claude takes a send-now at its next step; other agents stop the turn first.
  const rowTip = !stopShows ? t('composer.queue.sendTitle') : target?.kind === 'claude' ? t('composer.steerNowTitleClaude') : t('composer.steerNowTitle');
  // Ticket 1056: a held row says why it waits: a question or permission, rows ahead of it in the core's queue, or the turn.
  // The queue's own order: send_log is sorted by time, and a user row goes ahead of older wake lines.
  const heldLog = ((target as (Session & { send_queue?: { id: string; status: string; settle?: string | null }[] }) | null)?.send_queue ?? []).filter((r) => r.status === 'queued');
  // Ticket 1121: rows the core will not paste again (dropped past its re-paste bound, or no clean box read).
  const stopped = (target as (Session & { stopped_sends?: string[] }) | null)?.stopped_sends ?? [];
  const heldWhy = (id?: string) => {
    if (target && asks(target)) return t('chat.held.card');
    // Ticket 1094: the agent did not take it (its Enter was dropped); the core tries again when the agent is ready.
    if (id && stopped.includes(id)) return t('chat.held.stopped');
    if (id && heldLog.find((r) => r.id === id)?.settle?.startsWith('enter_dropped')) return t('chat.held.retry');
    const ahead = id ? heldLog.findIndex((r) => r.id === id) : -1;
    return ahead > 0 ? t('chat.held.behind', { n: ahead }) : t('chat.held.working');
  };
  // Ticket 1030: the card of the session in front; its keys act only while it has focus (Shift+Tab from the box).
  const inFront = !pin && !!target && target.id === front;
  const dockAsks = inFront ? waitingAsks(target.pending) : [];
  // Ticket 1097: the card's first item is a question with a "Type something" option (the card's own box, S2-7): what the box
  // sends goes as that option's answer, as T3 Code's composer does, not as a message held behind the card.
  const asked = dockAsks[0] as Item | undefined;
  const typeAt = target && asked?.kind === 'question' && !answered(asked.id) && !rowPlan([asked], target, t).note ? asked.choices.findIndex((c) => takesText(c.label)) : -1;
  const answersText = typeAt >= 0 ? t('composer.answersCard', { option: shown(asked!.choices[typeAt].label).trim().replace(/\.$/, '') }) : '';
  const answerCard = (box: HTMLTextAreaElement) => {
    const text = box.value.trim();
    // shortcut: words past the card box's 500-character limit, or with an image, go the held way; upgrade if a real answer needs either.
    if (!target || typeAt < 0 || !text || text.length > DENY_NOTE_MAX || images.of(target.id).length) return false;
    const p = onAnswer(asked!, { type: 'choose_with', index: typeAt, text });
    if (!p) return false;
    box.value = '';
    grow(box);
    setDrafts((d) => ({ ...d, [target.id]: false }));
    setDraft(target.id, '');
    void p.catch((e) => (toBox(box, text), setPaneNote(errorNote(notePlain(t, e), e))));
    return true;
  };
  const dockOut = inFront ? owner.filter((d) => d.owner?.type === 'outward' && d.session_id === target.id) : [];
  // Night tidy's card docks in the chat of the bot it is for (the Chief's, or each bot's own without a Chief).
  const dockNight = inFront ? owner.filter((d) => d.owner?.type === 'night_tidy' && !!target.teammate && d.session_id === target.teammate) : [];
  // Ticket 1130 C6 (owner Q2; mockup docs/design/first-use-b-1130/mockup.html #c6): a pasted stdio `claude mcp add` line
  // shows one offer row with the name and the whole command. Nothing is added before the click; the text stays in the box
  // and Enter still sends it. The add is Settings > Skills & hooks' own sealed `extensions_mcp_add` (env values never
  // saved). An idle agent restarts on its conversation; a busy one is never restarted by this button.
  const [offer, setOffer] = useState<(NonNullable<ReturnType<typeof composerOffer>> & { sid: string }) | null>(null);
  const [mcpAdded, setMcpAdded] = useState<{ name: string; restarted: boolean; kept: boolean; project: string } | null>(null);
  const [adding, setAdding] = useState(false);
  // Only on a change of drafts: a send empties the box (drafts false), and the offer goes with it.
  useEffect(() => void (offer && !drafts[offer.sid] && setOffer(null)), [drafts]); // eslint-disable-line react-hooks/exhaustive-deps
  const offers = !!target && target.kind !== 'shell' && !target.side_chat && !sideChats.includes(target.id) && agentState(target) === 'running';
  const shownOffer = offers && offer?.sid === target.id && drafts[target.id] ? offer : null;
  const restartsNow = offers && status(target) === 'idle';
  const keeps = restartsNow && !!restartStart(target).resume;
  const addOffered = async (box: HTMLTextAreaElement | null | undefined) => {
    if (!target || !shownOffer || !box || adding) return;
    const [s, o, restart] = [target, shownOffer, restartsNow];
    setAdding(true);
    try {
      await core.request({ op: 'extensions_mcp_add', name: o.name, command: o.command });
    } catch (e) {
      return setPaneNote(errorNote(notePlain(t, e), e));
    } finally {
      setAdding(false);
    }
    // The pasted line leaves the box, so Enter cannot send it by mistake (before the restart copies the draft over).
    // The add is async: the shared box may hold another session's draft by now, so only its own text is changed.
    const own = (box.dataset.draftFor ?? s.id) === s.id;
    const left = (own ? box.value : getDraft(s.id)).replace(o.line, '').trim();
    if (own) (box.value = left), grow(box);
    setDrafts((d) => ({ ...d, [s.id]: !!left }));
    setDraft(s.id, left);
    setOffer(null);
    setMcpAdded({ name: o.name, restarted: restart, kept: restart && keeps, project: s.project });
    // The core closes only an idle session (close_idle): one that started a turn meanwhile keeps it and gets the server
    // at its next restart, which is the "Add for new sessions" outcome.
    if (restart)
      await restartKeeping(core, s).catch((e) => {
        setMcpAdded((a) => a && { ...a, restarted: false, kept: false });
        if (!rawError(e).includes('is busy: not closed')) setPaneNote(errorNote(notePlain(t, e), e));
      });
  };
  const editRow = (rowId: string, button: HTMLElement) => {
    const box = button.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)');
    if (!target || !box) return; // the row stays: without a box its text would have nowhere to land
    const row = takeRow(target.id, rowId);
    if (row) toBox(box, row.text);
  };
  return (
    <div className="composer" data-hint-region="composer" data-pinned={pin ? '' : undefined}>
      {target && queued && (
        <div className="qlist" role="group" aria-label={t('composer.queue.label')}>
          <p className="qhead">
            {queued.paused ? (
              <><b>{t('composer.queue.stopped')}</b>{t('composer.queue.stoppedNote')}</>
            ) : (
              <><b><span aria-hidden="true">⏳ </span>{t('composer.queue.head', { n: queued.rows.length })}</b>{t('composer.queue.note')}</>
            )}
          </p>
          {queued.rows.map((r, i) => {
            const off = !connected || busyRow(queued, r.id) || !!r.sent;
            const name = (action: string) => t('composer.queue.rowAction', { n: i + 1, action });
            // Ticket 1087: a saved image goes as its path line (useComposerSend v1b-05); the row names it as its chip did.
            const lines = r.text.split('\n');
            const pic = (l: string) => l.startsWith('/') && l.includes(`/images/${target.id}/`);
            const pics = lines.filter(pic).length;
            return (
              <div className="qrow" key={r.id}>
                <span className="qn">{i + 1}</span>
                <span className="qt" title={r.text}>{lines.filter((l) => !pic(l)).join(' ')}</span>
                {Array.from({ length: pics }, (_, k) => (
                  <span className="qimg" key={k}>{t('composer.imageN', { n: k + 1 })}</span>
                ))}
                {r.sent && <span className="qn qsent" role="status">{t('composer.queue.sentWaiting')}</span>}
                <button className="qa" type="button" disabled={off} aria-label={name(t('composer.queue.edit'))} onClick={(e) => editRow(r.id, e.currentTarget)}>{t('composer.queue.edit')}</button>
                <button className="qa" type="button" disabled={off} aria-label={name(t('composer.queue.remove'))} onClick={() => takeRow(target.id, r.id)}>{t('composer.queue.remove')}</button>
                <button className="qa" type="button" disabled={off || (!stopShows && asks(target))} title={rowTip} aria-label={name(rowAct)} onClick={() => void pressRow(target, r.id)}>{rowAct}</button>
              </div>
            );
          })}
        </div>
      )}
      {/* Floats over the output's bottom edge: an arrival never resizes the composer or the terminal (answer-strip rule). */}
      {target && dockAsks.length + dockOut.length + dockNight.length > 0 && (
        <div className="dock" ref={dockHeight}>
          {dockNight.map((d) => (
            <div key={d.id} className="dock-out dock-fit">
              <NightTidyCard d={d} core={core} onAnswer={onAnswer} t={t} />
              <p className="dc-hint dc-also">{t('decisions.alsoInDecisions')}</p>
            </div>
          ))}
          {dockOut.map((d) => (
            <div key={d.id} className="dock-out">
              <OutboxCard d={d} onAnswer={onAnswer} t={t} />
              <p className="dc-hint dc-also">{t('decisions.alsoInDecisions')}</p>
            </div>
          ))}
          {dockAsks.length > 0 && <DecisionCard session={target} docked onAnswer={onAnswer} onBack={() => composer.current?.focus()} t={t} note={dockAsks.some(alsoInDecisions) ? t('decisions.alsoInDecisions') : undefined} />}
        </div>
      )}
      {shownOffer && (
        <div className="mcp-offer" role="group" aria-label={t('composer.mcp.offer', { name: shownOffer.name })}>
          <div className="mo-t">
            <b>{t('composer.mcp.offer', { name: shownOffer.name })}</b>
            <button type="button" className="btn p" disabled={adding} aria-busy={adding || undefined} onClick={(e) => void addOffered(e.currentTarget.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)'))}>
              {t(restartsNow ? 'composer.mcp.restart' : 'composer.mcp.forNew')}
            </button>
            <button type="button" className="mo-x" aria-label={t('mw.dismiss')} onClick={() => setOffer(null)}>
              ×
            </button>
          </div>
          <span className="mono">{escaped(joinWords(shownOffer.command))}</span>
          <small>{restartsNow ? `${t('composer.mcp.runs')}${keeps ? ` ${t('composer.mcp.keeps')}` : ''}` : t('composer.mcp.busy', { session: name ?? '', name: shownOffer.name })}</small>
          {shownOffer.dropped.length > 0 && <small>{t('firstUse.mcp.envDropped', { names: shownOffer.dropped.join(', ') })}</small>}
        </div>
      )}
      {target && mcpAdded && !shownOffer && target.project === mcpAdded.project && (
        <div className="mcp-offer" role="status">
          <div className="mo-t">
            <b className="ok-line">{t(mcpAdded.restarted ? 'composer.mcp.restarted' : 'firstUse.mcp.added', { name: mcpAdded.name })}</b>
            <span className="mo-seal">{t('composer.mcp.sealed')}</span>
            <button type="button" className="mo-x" aria-label={t('mw.dismiss')} onClick={() => setMcpAdded(null)}>
              ×
            </button>
          </div>
          <small>{`${mcpAdded.kept ? `${t('composer.mcp.kept')} ` : ''}${t('composer.mcp.listed')}`}</small>
        </div>
      )}
      {/* v1b-05: paste and drop of images, and their chips */}
      <div className="cbox" {...composerDrop(images, target?.id)}>
        {target && <ImageChips chips={images.of(target.id)} error={images.error(target.id)} onRemove={(id) => images.remove(target.id, id)} />}
        {target && (handoff?.fork?.id ?? handoff?.from) === target.id && handoff && (
          <HandoffChip
            sideChat={!!handoff.fork && (target.side_chat || sideChats.includes(target.id))}
            t={t}
            pending={handoff}
            onEdit={(text) => setHandoff((h) => h && { ...h, text })}
            onCancel={() => setHandoff(null)}
            onSend={(from) => void send(from.closest('.cbox')!.querySelector('textarea:not(.hoff-edit)')!, target)}
          />
        )}
        {target && <AttachedChips session={target} team={team} core={core} t={t} />}
        {target && homed && (
          <p className="chint" role="status" data-homed="">
            {t('home.note')} <kbd className="kbd">⌘Z</kbd> {t('home.undo')}
          </p>
        )}
        {target && undone?.id === target.id && (
          <p className="chint" role="status" data-undone="">
            {undone.text}
          </p>
        )}
        {target && held !== undefined && (
          <p className="queued held" role="status">
            <b>{t('chat.held.lead')}</b> <span className="queued-text">{held}</span>
            <button className="steer" aria-label={t('chat.held.cancel')} data-tip={t('chat.held.cancelTip')} onClick={(e) => giveBackHeld(e.currentTarget.closest('.cbox')!.querySelector('textarea:not(.hoff-edit)')!)}>
              {t('chat.held.cancel')}
            </button>
          </p>
        )}
        {briefHeld && (
          <p className="queued held" role="status">
            <b>{heldWhy()}</b> <span className="queued-text">{t('chat.row.brief')}</span>
          </p>
        )}
        {cardHeld.map((r) => (
          <p key={r.id} className="queued held" role="status">
            <b>{heldWhy(r.id)}</b> <span className="queued-text">{r.content}</span>
            <button className="steer" aria-label={t('chat.held.cancel')} data-tip={t('chat.held.cancelTip')} onClick={(e) => void cancelCardHeld(e.currentTarget.closest('.cbox')!.querySelector('textarea:not(.hoff-edit)')!, r)}>
              {t('chat.held.cancel')}
            </button>
          </p>
        ))}
        {target && held !== undefined && refused && <p className="chint held-why" role="status">{t('chat.held.second')}</p>}
        {target && answersText && drafts[target.id] && <p className="chint" role="status">{answersText}</p>}
        {target && uncertainSend[target.id] && <p className="chint" role="status">{t('chat.handoff.unknown')}</p>}
        {target && pendingEnter[target.id] && <p className="chint" role="status">{t('chat.handoff.retry')}</p>}
        <label className="sr" htmlFor={first ? 'composer' : undefined}>
          {t('composer.label', { name: name ?? t('composer.sessionFallback') })}
        </label>
        <textarea
          {...PLAIN}
          id={first ? 'composer' : undefined}
          data-kind={target?.kind}
          ref={(el) => {
            if (!first) return;
            composer.current = el;
            // V2.5-54 A8: a box meeting another session than the one it last held (a tab switch, or a new box) keeps the old
            // session's text as its draft and shows this one's. The box's own text is the truth at that moment.
            if (el && target && el.dataset.draftFor !== target.id) {
              if (el.dataset.draftFor) setDraft(el.dataset.draftFor, el.value);
              el.value = getDraft(target.id);
              el.dataset.draftFor = target.id;
              grow(el);
              if (el.value) setDrafts((d) => (d[target.id] ? d : { ...d, [target.id]: true }));
            }
            const back = el && target ? givenBack[target.id] : '';
            if (el && back && !el.value) {
              el.value = back;
              grow(el);
              if (target) setDrafts((d) => ({ ...d, [target.id]: true }));
            }
          }}
          aria-label={first ? undefined : t('composer.label', { name: name ?? t('composer.sessionFallback') })}
          aria-describedby={first && target && agentState(target) !== 'running' ? 'composer-why' : undefined}
          // While Continue starts the session the box takes words (they follow the new id as its draft); Enter waits below.
          disabled={!connected || !target || (agentState(target) !== 'running' && !resuming)}
          placeholder={target ? (agentState(target) === 'running' ? (target.kind !== 'shell' && asks(target) ? (answersText || t('composer.waitsHint')) + (asked?.kind === 'question' ? ` ${t('composer.digitsCard')}` : '') + (dockAsks.length ? ` ${t('composer.toCard')}` : '') : t('composer.placeholder', { name: sessionName(target).replace(/(\.\.\.|…)$/, '') }) /* N8: a name cut to "..." gets the placeholder's one "…" */) : '') : pin ? t('composer.notRunning', { pin }) : t('composer.open')}
          onPaste={(e) => {
            const o = offers && target ? composerOffer(e.clipboardData.getData('text/plain')) : null;
            if (o && target) setOffer({ ...o, sid: target.id });
          }}
          onCompositionUpdate={() => typingPing(core, target)}
          onInput={(e) => {
            const el = e.currentTarget; // read now: the updater below runs after the event is gone
            typingPing(core, target); // the gap rule: another sender's message waits while the owner types
            if (target) clearHomed(target.id); // his own edit: the line about the words from the terminal goes
            if (undone) setUndone(null);
            grow(el);
            if (offer && offer.sid === target?.id && !el.value.includes(offer.line)) setOffer(null); // the pasted line was edited away
            if (!target) return;
            if (givenBack[target.id]) setGivenBack(({ [target.id]: _, ...rest }) => rest); // typed over: it is the user's now
            const typed = !!el.value;
            setDrafts((d) => (!!d[target.id] === typed ? d : { ...d, [target.id]: typed })); // same answer: no new object, no re-render per key
            setDraft(target.id, el.value);
          }}
          onKeyDown={(e) => {
            // ⌘Z takes out what Nunchiro put in (nunchiroWrites.ts); otherwise it is the box's own undo.
            if (e.code === 'KeyZ' && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.nativeEvent.isComposing && undoWrite(e.currentTarget)) return e.preventDefault();
            // Ticket 1030: Shift+Tab goes to the card above (its first safe action), where 1 and 3 answer.
            if (e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing && dockAsks.length && focusCard(e.currentTarget.closest('.composer')?.querySelector('.deccard.docked'))) return e.preventDefault();
            // Ticket 1097: in an empty box a digit answers the card above, as Claude Code's own prompt takes it (T3 Code and Orca
            // too); after any text it is text. digitButton keeps a risky permission to focus then Enter. The key's code, as the
            // card's own keys: under a Korean input source e.key may not be the digit. Never with Shift: "!" is the shell cue
            // (ticket 1044) and "@" a mention, and neither may answer (review r2 MUST).
            if (!e.currentTarget.value && dockAsks.length && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              const button = digitButton(e.currentTarget.closest('.composer')?.querySelector('.deccard.docked'), /^Digit([1-9])$/.exec(e.code)?.[1] ?? '');
              if (button) return (e.preventDefault(), button.click());
            }
            // A held message waits on a pending ask, which reads "waiting" (no Stop; Esc would answer the dialog), so this Esc only
            // gives the words back; once nothing is held and the agent works, the next Esc reaches CHAT-STOP below (V2.5-82).
            if (e.key === 'Escape' && held !== undefined && !e.nativeEvent.isComposing && e.keyCode !== 229) return (e.preventDefault(), giveBackHeld(e.currentTarget));
            if (e.key === 'Escape' && cardHeld.length && !stopShows && !e.nativeEvent.isComposing && e.keyCode !== 229) return (e.preventDefault(), void cancelCardHeld(e.currentTarget, cardHeld[cardHeld.length - 1]));
            // v2-3b: Esc drops a pending handoff (an IME's Esc is its own).
            if (e.key === 'Escape' && handoff && (handoff.fork?.id ?? handoff.from) === target?.id && !e.nativeEvent.isComposing && e.keyCode !== 229) return (e.preventDefault(), setHandoff(null));
            // CHAT-STOP: Esc stops the working agent; a held key and an IME's Esc do not.
            if (e.key === 'Escape' && stopShows && target && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              if (!e.repeat) stopAgent(target);
              return;
            }
            // Enter that commits a Hangul syllable is the IME's, never a send.
            if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
            // v25-sendkeys: Ctrl+Enter sends it now, Cmd+Enter starts a session with it and stays here; Shift+Enter is
            // the newline under both.
            const chord = chordOf(e);
            const steerKey = composerKey(bindings, chord) === 'steerNow';
            const background = composerKey(bindings, chord) === 'backgroundSend';
            if (!steerKey && !background && e.shiftKey) return;
            // On swap the chord falls to send, which queues. An empty box must not steer the top queued row.
            const steer = swap && target ? !steerKey && !background && plain && !!e.currentTarget.value.trim() : steerKey;
            e.preventDefault();
            if (target && agentState(target) !== 'running') return; // still starting after Continue: the words stay in the box
            if (steer) return void steerNow(e.currentTarget, target);
            if (background) return void backgroundSend(e.currentTarget, target);
            if (answerCard(e.currentTarget)) return;
            void send(e.currentTarget, target);
          }}
        />
        {target && agentState(target) !== 'running' && (
          <div className="whyline">
            <span className="why" id={first ? 'composer-why' : undefined}>{target.state === 'running' ? t('composer.agentEnded') : target.folder_gone ? t('walk5.composer.folderGone', { name: sessionName(target) }) : target.ended_ask ? t('walk5.composer.endedAsk', { name: sessionName(target), ask: target.ended_ask }) : target.state === 'exited' ? t('composer.exited', { name: sessionName(target) }) : target.state === 'failed' ? t('composer.failed', { name: sessionName(target) }) : target.state === 'resumable' ? t('walk5.composer.resumable', { name: sessionName(target) }) : target.state === 'closed' ? t('walk5.composer.closed', { name: sessionName(target) }) : t('composer.state', { name: sessionName(target), state: target.state })}</span>
            {/* Ticket 371 item 17: an agent that ended inside an open terminal is not restartable (its state is still running). */}
            {restartable(target) && !sideChats.includes(target.id) && (
              <button type="button" className="btn" disabled={!connected || resuming} title={t(target.agent_session_id ? 'composer.resumeTitle' : 'composer.restartTitle')} onClick={(e) => {
                const box = e.currentTarget.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)');
                flushSync(() => void resume(target)); // the box unlocks now, so typing straight after Continue lands in it
                box?.focus();
              }}>
                {t(target.agent_session_id ? 'history.continue' : 'composer.restart') /* ticket 1025: one word with History's row */}
              </button>
            )}
          </div>
        )}
        {/* v1a-68 r4 (needs 78): a closed shell's text lives in the core's memory; Save to file keeps it. */}
        {target && target === current && closedText?.id === target.id && (
          <span className="keeps">
            <button
              className="keep"
              onClick={() =>
                void download(sessionName(target), closedText.text).then(
                  (path) => setPaneNote(path && path !== 'cancelled' ? t('mw.composer.savedTo', { path }) : ''),
                  (e) => setPaneNote(errorNote(t('err.note.notSaved', { error: notePlain(t, e) }), e)),
                )
              }
            >
              {t('mw.composer.saveFile')}
            </button>
            <button className="keep" title={t('mw.composer.tempTip')} onClick={() => run('terminal.edit')}>
              {t('mw.composer.tempCopy', { editor: '$EDITOR' })}
            </button>
          </span>
        )}
        <div className="chips">
          {target && <PlusMenu disabled={agentState(target) !== 'running'} onFiles={(files) => void images.add(target.id, files)} />}
          <ComposerMenu core={core} session={target} t={t} />
          <ComposerStash session={target} name={name ?? ''} images={images} t={t} />
          {pin && <span className="chip pin">📌 <span className="chip-t">{pin}</span></span>}
          {target && (
            <span className="chip" title={placeText(target)}>
              <Icon name="project" size={12} /> <span className="chip-t">{placeText(target)}</span>
            </span>
          )}
          {/* Ticket 1087: shown by CSS while the box holds a "!" command (data-shell, set by grow) */}
          {target && (target.kind === 'claude' || target.kind === 'codex') && (
            <span className="chip shellchip" title={t('composer.shellHint', { folder: target.cwd })}>
              <b aria-hidden="true">!</b> {t('composer.shell')} <span className="chip-t">{t('composer.shellHint', { folder: target.cwd.split('/').filter(Boolean).pop() ?? target.cwd })}</span>
            </span>
          )}
          <span className="sp" />
          {/* v1a-10: model and effort for this session; a Codex switch resumes under a new id, so its tab follows. */}
          <Picker
            key={target?.id}
            core={core}
            session={target}
            connected={connected}
            disabledReason={target && (target.side_chat || sideChats.includes(target.id)) ? t('chat.side.locked') : undefined}
            sessions={sessions} // v2-3b
            onManage={() => openAgents()}
            onReplaced={(old, next) => follow(old, next.id, true)}
            running={context?.type === 'unknown' ? undefined : context?.model}
            typed={!!target && !!drafts[target.id]}
          />
          {/* Look v18 A-O1: the mode chip, ring and Send wrap as one, so Send never sits alone on a second line. */}
          <span className="tail">
            <PermChip core={core} session={target} connected={connected} t={t} typed={!!target && !!drafts[target.id]} sideChat={!!target && (target.side_chat || sideChats.includes(target.id))} />
            <ContextRing value={context} t={t} />
            {stopShows ? (
              <button className="send stop" aria-label={t('composer.stop')} title={t('composer.stopTitle')} onClick={() => stopAgent(target)}>
                <Icon name="square-fill" size={16} />
              </button>
            ) : (
              <button className="send" aria-label={t('composer.send')} onClick={(e) => {
                const box = e.currentTarget.closest('.cbox')!.querySelector<HTMLTextAreaElement>('textarea:not(.hoff-edit)')!;
                if (!answerCard(box)) void send(box, target);
              }} disabled={!target || agentState(target) !== 'running' || !(drafts[target.id] || images.of(target.id).length || pendingEnter[target.id] || (handoff?.fork?.id ?? handoff?.from) === target.id)}>
                <ChromeIcon name="arrow-up" size={16} />
              </button>
            )}
          </span>
        </div>
      </div>
      {/* v25-chat-calm (needs 144): the key hint only while a message waits in the list and the turn runs. */}
      {stopShows && !!queued && (
      <p className="chint" aria-label={t('composer.keys')}>
        <span><kbd className="kbd">⏎</kbd> {t(swap && plain ? 'composer.steerNow' : swap ? 'followup.hintQueue' : 'composer.hintSend')}</span>
        <span><kbd className="kbd">⇧⏎</kbd> {t('composer.hintNewline')}</span>
        {/* v25-sendkeys: both keys, from the key map so a rebound chord reads as bound. */}
        <span><kbd className="kbd">{label(bindings['composer.steerNow']?.[0] ?? 'Control+Enter', bindings)}</kbd> {t(swap ? 'followup.hintQueue' : 'composer.steerNow')}</span>
        <span><kbd className="kbd">{label(bindings['composer.backgroundSend']?.[0] ?? 'Meta+Enter', bindings)}</kbd> {t('composer.backgroundSend')}</span>
        <span><kbd className="kbd">Esc</kbd> {t('composer.hintStop')}</span>
      </p>
      )}
    </div>
  );
}
