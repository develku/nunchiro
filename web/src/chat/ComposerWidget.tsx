// Chat: the composer widget (split out of App.tsx, needs 183).
import { PLAIN } from '../plainText';
import { errorNote, notePlain, type Note } from '../errors';
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
import { WayChip } from '../lead/WayMenu'; // ticket 990 slice i
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
import { DecisionCard, focusCard } from './DecisionCard'; // ticket 1030
import { OutboxCard } from '../lead/OutboxCard';
import { alsoInDecisions, asks as waitingAsks } from '../tree/decisions';
import type { OnAnswer } from '../tree/DecisionLine';
import type { Decision } from '../types';
import { useFeatureSetting } from '../settings/useFeatureSetting';

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

/** Ticket 1030: the floating card's height as `--dock-h`, so the output's last lines and its "new" chip stay clear of it. */
const dockHeight = (el: HTMLDivElement | null) => {
  if (!el) return;
  const root = document.documentElement.style;
  const watch = new ResizeObserver(() => root.setProperty('--dock-h', `${Math.ceil(el.offsetHeight)}px`));
  watch.observe(el);
  return () => void (watch.disconnect(), root.removeProperty('--dock-h'));
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
  /** Words coming back to the box go ahead of whatever it already holds. */
  const toBox = (box: HTMLTextAreaElement, text: string) => {
    if (!target) return;
    box.value = box.value ? `${text}\n${box.value}` : text;
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
  // Ticket 1030: the card of the session in front; its keys act only while it has focus (Shift+Tab from the box).
  const inFront = !pin && !!target && target.id === front;
  const dockAsks = inFront ? waitingAsks(target.pending) : [];
  const dockOut = inFront ? owner.filter((d) => d.owner?.type === 'outward' && d.session_id === target.id) : [];
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
            const off = !connected || busyRow(queued, r.id);
            const name = (action: string) => t('composer.queue.rowAction', { n: i + 1, action });
            return (
              <div className="qrow" key={r.id}>
                <span className="qn">{i + 1}</span>
                <span className="qt" title={r.text}>{r.text}</span>
                <button className="qa" type="button" disabled={off} aria-label={name(t('composer.queue.edit'))} onClick={(e) => editRow(r.id, e.currentTarget)}>{t('composer.queue.edit')}</button>
                <button className="qa" type="button" disabled={off} aria-label={name(t('composer.queue.remove'))} onClick={() => takeRow(target.id, r.id)}>{t('composer.queue.remove')}</button>
                <button className="qa" type="button" disabled={off || (!stopShows && asks(target))} title={stopShows ? t('composer.steerNowTitle') : t('composer.queue.sendTitle')} aria-label={name(rowAct)} onClick={() => void pressRow(target, r.id)}>{rowAct}</button>
              </div>
            );
          })}
        </div>
      )}
      {/* Floats over the output's bottom edge: an arrival never resizes the composer or the terminal (answer-strip rule). */}
      {target && dockAsks.length + dockOut.length > 0 && (
        <div className="dock" ref={dockHeight}>
          {dockOut.map((d) => (
            <div key={d.id} className="dock-out">
              <OutboxCard d={d} onAnswer={onAnswer} t={t} />
              <p className="dc-hint dc-also">{t('decisions.alsoInDecisions')}</p>
            </div>
          ))}
          {dockAsks.length > 0 && <DecisionCard session={target} docked onAnswer={onAnswer} onBack={() => composer.current?.focus()} t={t} note={dockAsks.some(alsoInDecisions) ? t('decisions.alsoInDecisions') : undefined} />}
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
            <b>{t('chat.held.card')}</b> <span className="queued-text">{t('chat.row.brief')}</span>
          </p>
        )}
        {cardHeld.map((r) => (
          <p key={r.id} className="queued held" role="status">
            <b>{t('chat.held.card')}</b> <span className="queued-text">{r.content}</span>
            <button className="steer" aria-label={t('chat.held.cancel')} data-tip={t('chat.held.cancelTip')} onClick={(e) => void cancelCardHeld(e.currentTarget.closest('.cbox')!.querySelector('textarea:not(.hoff-edit)')!, r)}>
              {t('chat.held.cancel')}
            </button>
          </p>
        ))}
        {target && held !== undefined && refused && <p className="chint held-why" role="status">{t('chat.held.second')}</p>}
        {target && uncertainSend[target.id] && <p className="chint" role="status">{t('chat.handoff.unknown')}</p>}
        {target && pendingEnter[target.id] && <p className="chint" role="status">{t('chat.handoff.retry')}</p>}
        <label className="sr" htmlFor={first ? 'composer' : undefined}>
          {t('composer.label', { name: name ?? t('composer.sessionFallback') })}
        </label>
        <textarea
          {...PLAIN}
          id={first ? 'composer' : undefined}
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
          disabled={!connected || !target || agentState(target) !== 'running'}
          placeholder={target ? (agentState(target) === 'running' ? (target.kind !== 'shell' && asks(target) ? t('composer.waitsHint') + (dockAsks.length ? ` ${t('composer.toCard')}` : '') : t('composer.placeholder', { name: sessionName(target).replace(/(\.\.\.|…)$/, '') }) /* N8: a name cut to "..." gets the placeholder's one "…" */) : '') : pin ? t('composer.notRunning', { pin }) : t('composer.open')}
          onInput={(e) => {
            const el = e.currentTarget; // read now: the updater below runs after the event is gone
            grow(el);
            if (!target) return;
            if (givenBack[target.id]) setGivenBack(({ [target.id]: _, ...rest }) => rest); // typed over: it is the user's now
            const typed = !!el.value;
            setDrafts((d) => (!!d[target.id] === typed ? d : { ...d, [target.id]: typed })); // same answer: no new object, no re-render per key
            setDraft(target.id, el.value);
          }}
          onKeyDown={(e) => {
            // Ticket 1030: Shift+Tab goes to the card above (its first safe action), where 1 and 3 answer.
            if (e.key === 'Tab' && e.shiftKey && !e.nativeEvent.isComposing && dockAsks.length && focusCard(e.currentTarget.closest('.composer')?.querySelector('.deccard.docked'))) return e.preventDefault();
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
            if (steer) return void steerNow(e.currentTarget, target);
            if (background) return void backgroundSend(e.currentTarget, target);

            void send(e.currentTarget, target);
          }}
        />
        {target && agentState(target) !== 'running' && (
          <div className="whyline">
            <span className="why" id={first ? 'composer-why' : undefined}>{target.state === 'running' ? t('composer.agentEnded') : target.folder_gone ? t('walk5.composer.folderGone', { name: sessionName(target) }) : target.ended_ask ? t('walk5.composer.endedAsk', { name: sessionName(target), ask: target.ended_ask }) : target.state === 'exited' ? t('composer.exited', { name: sessionName(target) }) : target.state === 'failed' ? t('composer.failed', { name: sessionName(target) }) : target.state === 'resumable' ? t('walk5.composer.resumable', { name: sessionName(target) }) : target.state === 'closed' ? t('walk5.composer.closed', { name: sessionName(target) }) : t('composer.state', { name: sessionName(target), state: target.state })}</span>
            {/* Ticket 371 item 17: an agent that ended inside an open terminal is not restartable (its state is still running). */}
            {restartable(target) && !sideChats.includes(target.id) && (
              <button type="button" className="btn" disabled={!connected || resuming} title={t(target.agent_session_id ? 'composer.resumeTitle' : 'composer.restartTitle')} onClick={() => resume(target)}>
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
          <span className="sp" />
          <WayChip t={t} core={core} session={target} connected={connected} sessions={sessions} />
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
              <button className="send" aria-label={t('composer.send')} onClick={(e) => void send(e.currentTarget.closest('.cbox')!.querySelector('textarea:not(.hoff-edit)')!, target)} disabled={!target || agentState(target) !== 'running' || !(drafts[target.id] || images.of(target.id).length || pendingEnter[target.id] || (handoff?.fork?.id ?? handoff?.from) === target.id)}>
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
