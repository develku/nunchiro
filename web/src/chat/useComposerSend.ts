// Chat: the composer's send path (split out of App.tsx, needs 183).
import { markStopped, STOP_RETURN_EVENT } from './stopped';
import { errorNote, heldNote, notePlain, plainError, rawError, startOp, type Note } from '../errors';
import { useEffect, useRef, useState } from 'react';
import { AGENT_ENDED, CoreRefusal, CoreClient, NO_INTERRUPT, UNCERTAIN, type Account } from '../api';
import { sessionName } from '../Sidebar';
import { bracketedPaste } from '../Terminal';
import { getDraft, setDraft } from '../composer-drafts';
import { agentState, status, type Session } from '../types';
import type { Pending as Handoff, Preview } from './HandoffChip';
import { agentName, HANDOFF_EVENT, REWIND_EVENT, sideContext } from './conversation';
import { show as paneShow } from '../pane/store';
import { lastAccount, likeNew } from '../NewSession';
import { useImages } from '../images/attach';
import { asks, blocked, heldIds, holdText, refuseSecond, takeHeld } from './held';
import { claimSteer, enqueue, finishSteer, markSent, nextRow, noteSteer, putBack, queueIds, queueOf, recordStop, setPaused, takeAll, takeRow, unclaimSteer, unsend, useQueues, type Row } from './queued';
import { useSideChats } from './useSideChats';
import type { T } from '../i18n';

type Deps = {
  core: CoreClient;
  sessions: Session[];
  current: Session | null;
  ordered: Session[];
  images: ReturnType<typeof useImages>;
  handoff: ReturnType<typeof useSideChats>['handoff'];
  setHandoff: ReturnType<typeof useSideChats>['setHandoff'];
  sideChats: string[];
  follow: (old: string, next: string, modelReplacement?: boolean) => void;
  open: (id: string) => void;
  addTab: (id: string) => void;
  accountsP: { current: Promise<Account[]> | null };
  readAccounts: () => Promise<Account[]>;
  t: T;
  setPaneNote: (note: Note) => void;
  connected: boolean;
  snapped: { current: boolean };
};

/** sessions.rs `current` and `key_gate`: refusals before any byte is written that pass once the screen settles. */
const GATE = /^(screen not current, try again|a request you have not seen is pending: )/;

/** Ticket 1056: how long a sent row may go unseen in the transcript after the agent took it and went idle. */
const SENT_MS = 15_000;
/** Ticket 1056: at most one chat_page look a second for each sent row. */
const LOOK_MS = 1_000;
const seqOf = (s: Session) => (s as Session & { completion_seq?: number }).completion_seq ?? 0;
/** The core's row of a send (the snapshot's send_log carries the queue too). */
const logRow = (s: Session, send: string) => (s as Session & { send_log?: { id: string; status: string }[] }).send_log?.find((r) => r.id === send);

/** The composer's send path: Enter (`send`, a handoff or a fork), Ctrl+Enter (`steerNow`), Cmd+Enter (`backgroundSend`)
 *  and Stop (`stopAgent`), with the per-session send state the composer shows (drafts, given-back text) and the queued rows' release (queued.ts),
 *  and the handoff and fork requests (HANDOFF_EVENT). */
export function useComposerSend({ core, sessions, current, ordered, images, handoff, setHandoff, sideChats, follow, open, addTab, accountsP, readAccounts, t, setPaneNote, connected, snapped }: Deps) {
  const forking = useRef(false);
  const sentTo = useRef(new Set<string>()); // v25-quiet-chat: sessions this window has already sent a message to
  const sendingFork = useRef(new Set<string>());
  const [pendingEnter, setPendingEnter] = useState<Record<string, boolean>>({});
  const [uncertainSend, setUncertainSend] = useState<Record<string, boolean>>({});
  const escBusy = useRef(false); // CHAT-STOP: one Esc per press; a Stop still in flight ignores the next press
  const [drafts, setDrafts] = useState<Record<string, boolean>>({}); // CHROME: which session's composer holds text (Send is disabled when empty)
  // v25-sendkeys: text a refused send gave back while its box was being mounted again (the empty block's seat goes
  // when the turn starts), so the next box starts with it.
  const [givenBack, setGivenBack] = useState<Record<string, string>>({});
  /** The composer was emptied by a send or a stash: its saved draft goes too (A8), before any box mounts again. */
  const noDraft = (id: string) => (setDraft(id, ''), setDrafts((d) => ({ ...d, [id]: false })));
  /** The composer grows with its text up to a cap (claude-feel-2 .cmp textarea max-height 220). */
  const grow = (el: HTMLTextAreaElement) => {
    // Ticket 1044: every path that puts text in the box calls grow. Ticket 1087: "!" opens Claude's bash mode and Codex
    // 0.161's shell mode; an ACP agent gets the text as a prompt and a shell box is a shell already, so neither shows it.
    el.closest('.cbox')?.toggleAttribute('data-shell', (el.dataset.kind === 'claude' || el.dataset.kind === 'codex') && el.value.startsWith('!'));
    el.style.height = 'auto';
    // scrollHeight is a whole number but the box's own height is fractional (14.5px at 1.45): while the text fits, keep
    // the CSS height, or the composer shifts by 0.03px when a send resets it (ticket 599, v25-empty).
    if (el.scrollHeight > el.clientHeight) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  // The box draws its own text from here, so a box mounted a frame or two after the refusal starts with it, and no
  // frame loop races the mount. Never over text the user typed meanwhile.
  const giveBack = (text: HTMLTextAreaElement, target: Session | null, value: string) => {
    if (!target || !value) return;
    text.value = value;
    grow(text);
    setGivenBack((b) => ({ ...b, [target.id]: value }));
    setDrafts((d) => ({ ...d, [target.id]: true }));
    setDraft(target.id, value);
  };

  useEffect(() => {
    // A fork: a new session of the same agent, with the conversation up to `through` to hand over. A low-memory hold's note
    // offers Start anyway, the same fork past the hold; the composer's text is not touched either way.
    const fork = async (s: Session, through: string, anyway = false) => {
      const from = s.id;
      forking.current = true;
      try {
        const preview = (await core.request({ op: 'handoff_preview', id: from, through })) as Preview;
        const reply = (await core.request(startOp({ op: 'start', session: { kind: s.kind, project: s.cwd, resume: null, ...(s.account ? { account: s.account } : {}), ...(s.acp_agent ? { args: [s.acp_agent] } : {}) } }, anyway))) as { session: Session };
        setHandoff({ from, fromKind: s.kind, to: s.kind, preview, text: preview.text, error: null, fork: { id: reply.session.id, through } });
        open(reply.session.id);
      } catch (err) {
        setPaneNote(heldNote(t, err, agentName(s.kind, s.acp_agent), () => void fork(s, through, true)) ?? errorNote(t('err.note.notForked', { error: notePlain(t, err) }), err));
      } finally {
        forking.current = false;
      }
    };
    const on = async (e: Event) => {
      const { from, to, acp, through } = (e as CustomEvent<{ from: string; to?: Handoff['to']; acp?: string; through?: string }>).detail;
      const s = sessions.find((x) => x.id === from);
      if (!s || forking.current) return;
      if (through !== undefined) return void (await fork(s, through));
      if (!to || s.side_chat || sideChats.includes(from)) return;
      setHandoff({ from, fromKind: s.kind, to, acp, preview: null, text: '', error: null });
      core.request({ op: 'handoff_preview', id: from }).then(
        (r) => setHandoff((h) => (h?.from === from && h.to === to && h.acp === acp ? { ...h, preview: r as Preview, text: (r as Preview).text } : h)),
        (err) => setHandoff((h) => (h?.from === from && h.to === to && h.acp === acp ? { ...h, error: t('err.note.handoffRead', { error: plainError(t, err) }), details: rawError(err) } : h)),
      );
    };
    window.addEventListener(HANDOFF_EVENT, on);
    return () => window.removeEventListener(HANDOFF_EVENT, on);
  }, [sessions, core, open, sideChats]);
  // Ticket 371 item 20: only the command; every choice and confirmation is the CLI's own, in the terminal this opens.
  const rewinding = useRef(false);
  useEffect(() => {
    const on = (e: Event) => {
      const s = sessions.find((x) => x.id === (e as CustomEvent<string>).detail);
      if (!s || s.kind !== 'claude' || status(s) !== 'idle' || rewinding.current) return;
      rewinding.current = true;
      paneShow(s.id, 'pty', true);
      core
        .request({ op: 'agent_prompt', id: s.id, text: '/rewind' })
        .catch((err) => setPaneNote(errorNote(t('chat.message.rewindFailed', { error: notePlain(t, err) }), err)))
        // shortcut: a double-click's second press lands after the reply and would type into the open picker; one second covers it, upgrade when the core reports an open picker.
        .finally(() => setTimeout(() => (rewinding.current = false), 1000));
    };
    window.addEventListener(REWIND_EVENT, on);
    return () => window.removeEventListener(REWIND_EVENT, on);
  }, [sessions, core, t, setPaneNote]);
  // b3a52151a keeps `sessions` when a snapshot is unchanged: a message the gate refused waits on the next snapshot itself
  // (look 1117 v13 N3). Only while one is held, so an idle composer does not draw on every snapshot.
  const [anySnap, setAnySnap] = useState(0);
  useEffect(() => core.onAnySnapshot(() => void (heldIds().length && setAnySnap((n) => n + 1))), [core]);
  // v25-quiet-chat: a held first message goes in once its session has nothing pending; a session that ended gives it back.
  useEffect(() => {
    for (const id of heldIds()) {
      const target = sessions.find((x) => x.id === id);
      if (target && target.state === 'running' && blocked(target)) continue;
      const text = takeHeld(id);
      if (!text) continue;
      if (target && target.state === 'running') {
        const el = document.createElement('textarea');
        el.value = text;
        void send(el, target, true);
      } else {
        setGivenBack((b) => ({ ...b, [id]: text }));
        setDrafts((d) => ({ ...d, [id]: true }));
        setDraft(id, text);
      }
    }
  }, [sessions, anySnap]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ticket 371 item 15: the queued rows. `sessions` is empty until the first snapshot, so a missing session only counts
  // as ended once one has arrived on this connection.
  const queues = useQueues();
  const [wake, setWake] = useState(0);
  useEffect(() => {
    if (!connected || !snapped.current) return;
    let soonest = Infinity;
    for (const id of queueIds()) {
      const target = sessions.find((x) => x.id === id);
      if (!target || agentState(target) !== 'running') {
        const text = takeAll(id);
        if (text) rowsToDraft(id, text);
      } else if (!sendingFork.current.has(id)) {
        for (const r of queueOf(id)?.rows ?? []) if (r.sent) void watchSent(target, r);
        // Two windows read the same rows: taking one is a read and a write, so it runs under a lock both windows share,
        // or both could take the row and send it twice (seen in the nightly, 2026-11-16).
        const release = () => {
          const { row, retryIn } = nextRow(target);
          if (row) deliver(target, row);
          return retryIn;
        };
        if (navigator.locks) void navigator.locks.request('nunchiro.queued', release).then((retryIn) => retryIn && setTimeout(() => setWake((n) => n + 1), retryIn));
        else soonest = Math.min(soonest, release() ?? Infinity);
      }
    }
    if (soonest === Infinity) return;
    const timer = setTimeout(() => setWake((n) => n + 1), soonest);
    return () => clearTimeout(timer);
  }, [sessions, connected, queues, wake]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Ticket 1056: a row sent into Claude's running turn leaves when the transcript shows it. When the core canceled or
   *  failed it, it is a plain row again, once. Written and still unseen after SENT_MS of idle, it leaves too: the agent
   *  has the words (a stopped Claude puts them back in its own box), and a row given back here could go in twice. */
  const watching = useRef(new Set<string>());
  const looked = useRef(new Map<string, number>());
  const watchSent = async (s: Session, row: Row) => {
    const sent = row.sent;
    if (!sent || watching.current.has(row.id)) return;
    // A working Claude sends many snapshots: one chat_page per row a second, and a skipped look comes back by itself.
    const wait = (looked.current.get(row.id) ?? 0) + LOOK_MS - Date.now();
    if (wait > 0) return void setTimeout(() => setWake((n) => n + 1), wait);
    looked.current.set(row.id, Date.now());
    watching.current.add(row.id);
    try {
      if ((await transcriptCount(s, row.text)) > (sent.base ?? 0)) return void takeRow(s.id, row.id);
      const status = logRow(s, sent.send)?.status;
      if (status === 'canceled' || status === 'failed') return unsend(s.id, row.id);
      // A row gone from the log (its cap, a core restart) went in or was dropped; it must not stay "sent" for good.
      if ((status === 'delivered' || status === undefined) && !s.attention.working && Date.now() - sent.at > SENT_MS) takeRow(s.id, row.id);
    } catch {
      /* the next snapshot looks again */
    } finally {
      watching.current.delete(row.id);
    }
  };
  /** User messages with this text on the newest chat page (a `queued_command` is projected as one, chat/mod.rs). */
  const transcriptCount = async (s: Session, text: string) => {
    const page = ((await core.request({ op: 'chat_page', id: s.id })) as { page?: { events?: { data?: Record<string, unknown> }[] } }).page;
    return (page?.events ?? []).filter(({ data }) => data?.kind === 'message' && data.role === 'user' && typeof data.text === 'string' && data.text.includes(text.trim())).length;
  };
  /** Rows of a session that ended: first in its draft, any draft kept. A box showing that session is the draft's truth. */
  const rowsToDraft = (id: string, text: string) => {
    const box = document.querySelector<HTMLTextAreaElement>(`textarea[data-draft-for="${CSS.escape(id)}"]`);
    const kept = box ? box.value : getDraft(id);
    const merged = kept ? `${text}\n${kept}` : text;
    if (box) {
      box.value = merged;
      grow(box);
    }
    setDraft(id, merged);
    setDrafts((d) => ({ ...d, [id]: true }));
  };
  // v9-B-N2-S3-1: the message a Stop interrupted before any output comes back to an empty composer; a draft is never replaced.
  useEffect(() => {
    const on = (e: Event) => {
      const { id, text } = (e as CustomEvent<{ id: string; text: string }>).detail;
      const box = document.querySelector<HTMLTextAreaElement>(`textarea[data-draft-for="${CSS.escape(id)}"]`);
      if (!(box ? box.value : getDraft(id))) rowsToDraft(id, text);
    };
    window.addEventListener(STOP_RETURN_EVENT, on);
    return () => window.removeEventListener(STOP_RETURN_EVENT, on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- rowsToDraft reads no state
  /** A row already out of storage goes in through a detached box: the live box belongs to whatever the user is typing. */
  const deliver = (target: Session, row: Row) => {
    const el = document.createElement('textarea');
    el.value = row.text;
    void send(el, target, true, row);
  };
  /** A row's own button, and Ctrl+Enter with an empty box: "Send now" breaks the running turn; "Send" is a normal send. */
  const pressRow = async (target: Session, rowId: string) => {
    if (status(target) !== 'working') {
      if (asks(target) || sendingFork.current.has(target.id)) return; // the text would be taken as the answer
      const row = takeRow(target.id, rowId, target);
      if (row) deliver(target, row);
      return;
    }
    const row = claimSteer(target.id, rowId);
    if (!row) return;
    try {
      const base = target.kind === 'claude' ? await transcriptCount(target, row.text).catch(() => 0) : 0;
      const reply = (await core.request({ op: 'steer_now', id: target.id, text: row.text, seen: target.pending.map((d) => d.id) })) as { send?: { id?: string; status?: string } };
      // Stop's own delivery can fail and still reply Ok; then the text was never queued.
      if (reply?.send?.status === 'failed') throw new CoreRefusal('the interrupt did not go through');
      // Ticket 1056 (ticket 371 item 15's guard): Claude takes it at its next step, so the row stays, marked, until the
      // transcript shows it (`watchSent`).
      if (target.kind === 'claude' && reply?.send?.id) markSent(target.id, rowId, { send: reply.send.id, seq: seqOf(target), at: Date.now(), base });
      else finishSteer(target.id, rowId, target);
      noteSteer(target.id, row.text);
    } catch (e) {
      unclaimSteer(target.id);
      const why = rawError(e);
      if (why.startsWith(NO_INTERRUPT)) return setPaneNote(t('composer.steerNoInterrupt'));
      // Only the core's before-writing refusals prove nothing was sent, so anything else is never retyped.
      if (!(e instanceof CoreRefusal) || why.startsWith(UNCERTAIN)) {
        takeRow(target.id, rowId);
        setPaused(target.id, true);
        setUncertainSend((p) => ({ ...p, [target.id]: true }));
      }
      setPaneNote(errorNote(t('composer.queue.notSent', { error: notePlain(t, e) }), e));
    }
  };
  /** CHAT-STOP: Stop and Esc are the existing key path, one lone esc per press (the core's interrupt). */
  const stopAgent = (target: Session) => {
    if (escBusy.current) return;
    escBusy.current = true;
    // shortcut: a stop pressed inside the terminal pane never comes through here, so the list still goes in after it; upgrade when the core reports an interrupted turn.
    const undo = recordStop(target); // before the Esc: the turn's end must find the list already held
    // Ticket 1056: a sent row the core still holds is taken back before the Esc, so it never goes in after the Stop.
    for (const r of queueOf(target.id)?.rows ?? [])
      if (r.sent && logRow(target, r.sent.send)?.status === 'queued') void core.request({ op: 'cancel_send', id: target.id, send: r.sent.send }).then(() => unsend(target.id, r.id), () => {});
    markStopped(target.id); // N27
    core
      .sendKeys(target.id, ['esc'], target.pending.map((d) => d.id)) // ticket 115: what this window has drawn
      .catch((e) => (undo(), setPaneNote(errorNote(t('err.note.notStopped', { error: notePlain(t, e) }), e))))
      .finally(() => (escBusy.current = false));
  };
  // `released`: the held first message going in after its dialog was answered (el is a detached box; the live box and its
  // draft belong to whatever the user typed since). `row`: the same for a queued row, which a refusal returns to the list.
  const send = async (el: HTMLTextAreaElement, target: Session | null, released = false, row?: Row) => {
    // v1b-05 (block): images are saved first (nothing is written to the PTY if one fails or every chip is removed
    // meanwhile), then each absolute path goes on its own line after the text, in chip order, in the same write.
    if (target && sendingFork.current.has(target.id)) return;
    const retry = !!target && !!pendingEnter[target.id];
    const chips = target && !released ? images.of(target.id) : []; // a released message carries no chips added since
    const ho = !row && (handoff?.fork?.id ?? handoff?.from) === target?.id ? handoff : null; // v2-3b
    if (ho && !ho.preview) return;
    // Ticket 533: to an agent a box with only spaces is an empty box; a shell or a TUI prompt may want the spaces.
    if (!target || (!(target.kind === 'shell' ? el.value : el.value.trim()) && !chips.length && !ho && !retry) || chips.some((c) => c.saving)) return;
    // Look 1117 v13 N13-S2-3: while a permission waits, Send no longer denies it (Q7 point 3's redirect rejected the
    // Write by itself): the core holds the text until the card is answered, as behind a question.
    // One message waits at a time; a second stays in the box and the composer says why.
    if (!released && !ho && !retry && !sentTo.current.has(target.id) && blocked(target) && heldIds().includes(target.id)) return refuseSecond(target.id);
    if (ho?.fork || retry) sendingFork.current.add(target.id);
    let saved: { paths: string[]; done: () => void } = { paths: [], done: () => {} };
    if (chips.length)
      try {
        saved = await images.save(target.id);
      } catch {
        if (ho?.fork || retry) sendingFork.current.delete(target.id);
        return;
      }
    const typed = el.value;
    const text = [typed, ...saved.paths].filter(Boolean).join('\n');
    // v1b-05 (end of block)
    // v25-quiet-chat (ticket 294 item 2): the first message to a session, while a dialog (trust, imports) is still asked, would be taken
    // as its answer. Later messages keep ticket 123's path (the composer sends with `seen`).
    // The text waits in the window (held.ts) until the session has nothing pending.
    if (!released && !ho && !retry && text && !sentTo.current.has(target.id) && blocked(target)) {
      el.value = '';
      el.style.height = '';
      el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
      noDraft(target.id);
      saved.done();
      return holdText(target.id, text);
    }
    // v2-3b: this Enter carries the handoff: the core starts (or reuses) the other agent's session in this folder and
    // sends the handoff and the typed text there as one message; the tab follows it.
    if (ho && !ho.fork) {
      el.value = '';
      el.style.height = '';
      el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
      noDraft(target.id);
      setHandoff(null); // a second Enter meanwhile finds no handoff (the core also starts one target only)
      try {
        const reply = (await core.request({ op: 'handoff_send', from: ho.from, to: ho.to, ...(ho.acp ? { acp_agent: ho.acp } : {}), text: [ho.text, text].filter(Boolean).join('\n\n') })) as { session: Session };
        saved.done();
        follow(ho.from, reply.session.id);
      } catch (e) {
        el.value = typed;
        setHandoff({ ...ho, error: t('err.note.handoffSent', { error: plainError(t, e) }), details: rawError(e) });
      }
      return;
    }
    // Ticket 371 item 15: a plain send while the turn runs waits in the list, and behind any row still waiting its turn.
    const st = status(target);
    const waiting = queueOf(target.id);
    if (!released && !ho && !retry && target.kind !== 'shell' && (st === 'working' || (st === 'idle' && waiting && !waiting.paused))) {
      if (!text.trim()) return;
      if (!enqueue(target, text)) return setPaneNote(t('composer.queue.notSaved')); // the box and chips keep it
      el.value = '';
      el.style.height = '';
      el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
      noDraft(target.id);
      saved.done();
      return;
    }
    // A bracketed paste keeps multi-line text as one message; Enter is a separate, explicit submit.
    // Paste markers inside the text would end the bracketed paste early and run the rest as keys.
    let clean = text.replace(/\x1b\[20[01]~/g, '');
    // Cleared before the await: a cold tab's mode comes over the socket, and a second Enter or new typing must not meet the old text.
    el.value = '';
    el.style.height = '';
    el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
    if (!released) noDraft(target.id);
    const body = (await bracketedPaste(core, target.id)) ? `\x1b[200~${clean}\x1b[201~` : clean;
    const seen = target.pending.map((d) => d.id); // ticket 123: before the text, so a dialog drawn in the gap is unseen
    let acknowledged = false;
    try {
      let outgoing = body;
      if (ho?.fork) {
        setHandoff(null);
        const preview = (await core.request({ op: 'handoff_preview', id: ho.from, through: ho.fork.through, ...((target.side_chat || sideChats.includes(target.id)) ? { last_five: true } : {}) })) as Preview;
        const handoff = ho.text === ho.preview?.text ? preview.text : ho.text;
        const context = handoff && (target.side_chat || sideChats.includes(target.id)) ? sideContext(handoff) : handoff; // B12
        clean = [context, clean].filter(Boolean).join('\n\n').replace(/\x1b\[20[01]~/g, '');
        outgoing = (await bracketedPaste(core, target.id)) ? `\x1b[200~${clean}\x1b[201~` : clean;
      }
      if (!retry || clean) await core.sendText(target.id, outgoing, seen, true);
      acknowledged = true;
      sentTo.current.add(target.id);
      saved.done(); // v1b-05
      await new Promise((r) => setTimeout(r, 120));
      await core.sendKeys(target.id, ['enter'], seen, true);
      setPendingEnter((p) => { const next = { ...p }; delete next[target.id]; return next; });
    } catch (error) {
      // v25-sendkeys: a write that may have landed partway says `uncertain:`; the core only refuses before writing
      // on anything else, so only that marks the text as possibly sent (anything else is given back below).
      const unsure = error instanceof Error && rawError(error).startsWith(UNCERTAIN);
      const refused = error instanceof CoreRefusal && /; current line (?:not cleared:|could not be cleared:|cleared$)/.test(rawError(error));
      if (acknowledged && (ho?.fork || retry)) {
        setPendingEnter((p) => { const next = { ...p }; if (refused) next[target.id] = true; else delete next[target.id]; return next; });
        if (!refused) setUncertainSend((p) => ({ ...p, [target.id]: true }));
      }
      // v25-sendkeys: a write that may have landed partway says `uncertain:`; that text is never retyped. Any other
      // refusal wrote nothing, so the box may hold the text again.
      if (unsure) setUncertainSend((p) => ({ ...p, [target.id]: true }));
      // A queued row was on a detached box, so the give-back below would write over the draft. After `uncertain:` it is never retyped.
      if (row) {
        const ended = error instanceof CoreRefusal && rawError(error).startsWith(AGENT_ENDED);
        if (unsure) setPaused(target.id, true);
        else if (ended || !putBack(target.id, row)) rowsToDraft(target.id, row.text);
        if (!unsure) setPaneNote(ended ? t('composer.agentEnded') : errorNote(t('composer.queue.notSent', { error: notePlain(t, error) }), error));
        return;
      }
      // Look 1117 v13 N3: a first message the core's gate refused before writing (a startup screen redrawn, its question
      // gone from one snapshot) waits again, held, instead of landing back in the box without a word.
      if (!acknowledged && !ho && !retry && (released || !sentTo.current.has(target.id)) && error instanceof CoreRefusal && GATE.test(rawError(error))) return (saved.done(), holdText(target.id, text));
      if (ho?.fork && !acknowledged) setHandoff(ho);
      // An ACK consumes the handoff and draft even when Enter is refused; retry only unsent input.
      const restored = unsure || (acknowledged && (ho?.fork || retry)) ? el.value : typed;
      // v25-sendkeys: the box this send started from takes the text back; the state also fills it, for the case where
      // that box goes mid-send (the empty block's seat) and the composer is mounted again.
      giveBack(el, target, restored);
      // Ticket 286 (card C-20261106-03): the agent ended; the core wrote nothing and the text is back in the box.
      if (error instanceof CoreRefusal && rawError(error).startsWith(AGENT_ENDED)) setPaneNote(t('composer.agentEnded'));
    } finally {
      if (ho?.fork || retry) sendingFork.current.delete(target.id);
    }
  };

  // v25-sendkeys: Ctrl+Enter. The core breaks the turn with the Stop key and enters the text once; a kind with no
  // turn to break refuses with `no_interrupt:` and leaves the queue as it was.
  // An empty box with rows waiting sends the top row, as its own button would.
  const steerNow = async (el: HTMLTextAreaElement, target: Session | null) => {
    if (!target) return;
    const chips = images.of(target.id);
    if (!el.value.trim() && !chips.length) {
      const top = queueOf(target.id)?.rows.find((r) => !r.sent); // ticket 1056: a sent row is the agent's already
      return top ? pressRow(target, top.id) : undefined;
    }
    // Ticket 1087: the images go with the words, as Enter's send does (v1b-05): saved first, each path on its own line.
    if (chips.some((c) => c.saving)) return;
    let saved: { paths: string[]; done: () => void } = { paths: [], done: () => {} };
    if (chips.length)
      try {
        saved = await images.save(target.id);
      } catch {
        return; // the chips stay and say why
      }
    const typed = el.value;
    const text = [typed, ...saved.paths].filter(Boolean).join('\n');
    el.value = '';
    el.style.height = '';
    el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
    noDraft(target.id);
    try {
      await core.request({ op: 'steer_now', id: target.id, text, seen: target.pending.map((d) => d.id) });
      saved.done();
      noteSteer(target.id, text);
    } catch (e) {
      const why = rawError(e);
      // A kind with no turn to break refuses before writing: the text goes back in the box (the chips stayed), where Enter queues it.
      if (why.startsWith(NO_INTERRUPT)) {
        el.value = typed;
        setDrafts((d) => ({ ...d, [target.id]: true }));
        grow(el);
        return setPaneNote(t('composer.steerNoInterrupt'));
      }
      // A write that failed after its bytes may have reached the agent says `uncertain:` and is never given back. Any other
      // failure is: a before-writing refusal sent nothing; a lost reply (socket drop, timeout; Q9 tt-J22-1) proves neither
      // way, so its text comes back marked as maybe sent.
      if (!why.startsWith(UNCERTAIN)) giveBack(el, target, typed);
      else saved.done(); // maybe sent: its images are not offered again
      if (why.startsWith(UNCERTAIN) || !(e instanceof CoreRefusal)) setUncertainSend((p) => ({ ...p, [target.id]: true }));
      setPaneNote(errorNote(t('composer.backgroundFailed', { error: notePlain(t, e) }), e));
    }
  };
  // v25-sendkeys: Cmd+Enter starts a session with this text in the agent and folder the New Session dialog would
  // prefill (the same `start` request and its checks) and stays on the current view; the tree shows it working.
  /** `held`: the held start's Start anyway, which sends the text that was held, past the hold. The box is cleared only
   *  while it still holds that text (it was given back there); words typed since stay. */
  const backgroundSend = async (el: HTMLTextAreaElement, box: Session | null, held?: string) => {
    const anyway = held !== undefined;
    const text = held ?? el.value.trim();
    if (!text) return;
    const project = current?.project ?? ordered.find((s) => s.kind !== 'shell')?.project;
    if (!project) return setPaneNote(t('composer.backgroundFailed', { error: 'no project to start in' }));
    // New Session's own prefill: the agent last used in this folder, else Claude.
    const kind = [...ordered].reverse().find((s) => s.project === project && s.kind !== 'shell')?.kind ?? 'claude';
    const mine = el.value.trim() === text;
    if (mine) {
      el.value = '';
      el.style.height = '';
      el.closest('.cbox')?.removeAttribute('data-shell'); // ticket 1044: the "!" cue ends with the text
      if (box) noDraft(box.id); // Q9 tt-J22-2: a reload must not bring the sent text back
    }
    let started: Session | null = null;
    try {
      const accounts = (await (accountsP.current ?? readAccounts())).filter((a) => a.agent === kind);
      const account = accounts.length < 2 ? null : lastAccount(ordered, kind, project, accounts);
      const reply = (await core.request(
        startOp({ op: 'start', session: { kind, project, ...likeNew(current, ordered, kind, project), resume: null, ...(account ? { account } : {}) } }, anyway),
      )) as { session?: Session };
      if (!reply.session) throw new Error('the core started nothing');
      started = reply.session;
      addTab(started.id); // in the tree, the view stays
      await core.request({ op: 'agent_prompt', id: started.id, text });
      setPaneNote(t('composer.backgroundSent', { name: sessionName(started) }));
    } catch (e) {
      // The session is up but its text is not: the text is not put back in the box, where a second Cmd+Enter would
      // start a second session with it.
      if (!started) {
        if (!mine) {
          // The box holds newer words: they stay, and Start anyway still carries the held text.
        } else if (box) giveBack(el, box, text);
        else (el.value = text), grow(el);
      } else setDraft(started.id, text); // the new session's box holds the text its prompt did not take
      // Held for low memory: the text is back in the box, and Start anyway sends that same text past the hold.
      setPaneNote((!started && heldNote(t, e, agentName(kind), () => void backgroundSend(el, box, text))) || errorNote(t('composer.backgroundFailed', { error: notePlain(t, e) }), e));
    }
  };
  return { pendingEnter, uncertainSend, pressRow, drafts, setDrafts, givenBack, setGivenBack, grow, stopAgent, send, steerNow, backgroundSend };
}
